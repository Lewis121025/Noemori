//! 显式运行的规模验收；真实写入和独立解压，不用小文件替代 ZIP64 边界。
use super::{action, fixture, prepare};
use crate::OperationControl;
use noemori_vault::export::{EXPORT_BYTE_LIMIT, EXPORT_FILE_LIMIT};
use serde_json::json;
use std::{fs, process::Command, time::Instant};

#[tokio::test(flavor = "multi_thread")]
#[ignore = "需要 20 GiB 临时磁盘；由 test:export:stress 明确运行"]
async fn ten_thousand_files_five_gib_zip64_and_independent_recovery() {
    let (_data, root, out, runtime) = fixture().await;
    let original_bytes = fs::metadata(root.path().join("a.md")).unwrap().len();
    fs::create_dir(root.path().join("many")).unwrap();
    for index in 0..EXPORT_FILE_LIMIT - 2 {
        fs::write(root.path().join(format!("many/{index:05}.bin")), []).unwrap();
    }
    let large = fs::File::create(root.path().join("large.bin")).unwrap();
    large.set_len(EXPORT_BYTE_LIMIT - original_bytes).unwrap();
    large.sync_all().unwrap();
    let started = Instant::now();
    prepare(&runtime, root.path(), OperationControl::default()).await;
    let info = action(&runtime, json!({"action":"info"}), vec![])
        .await
        .unwrap();
    assert_eq!(info["files"].as_array().unwrap().len(), EXPORT_FILE_LIMIT);
    assert_eq!(info["bytes"], EXPORT_BYTE_LIMIT);
    for entry in info["files"].as_array().unwrap() {
        let path = entry["path"].as_str().unwrap();
        action(
            &runtime,
            json!({"action":"copy","source":path,"path":format!("vault/{path}")}),
            vec![],
        )
        .await
        .unwrap();
    }
    action(&runtime, json!({"action":"seal"}), vec![])
        .await
        .unwrap();
    let target = out.path().join("large.zip");
    action(&runtime, json!({"action":"target","path":target}), vec![])
        .await
        .unwrap();
    action(&runtime, json!({"action":"publish","single":null}), vec![])
        .await
        .unwrap();
    assert!(fs::metadata(&target).unwrap().len() > EXPORT_BYTE_LIMIT);
    assert!(started.elapsed().as_secs() <= 600, "5 GiB 归档超过 10 分钟");
    // Python 的 ZIP64、CRC 和 SHA-256 实现独立于 Rust 生产打包器。
    let manifest = out.path().join("expected.json");
    fs::write(&manifest, serde_json::to_vec(&info["files"]).unwrap()).unwrap();
    let validation = Command::new("python3")
        .arg("-c")
        .arg(
            r"
import hashlib, json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    expected = json.load(open(sys.argv[2]))
    assert sum(not f.is_dir() for f in archive.infolist()) == len(expected)
    assert any(f.file_size > 2**32 for f in archive.infolist())
    for record in expected:
        digest = hashlib.sha256()
        size = 0
        with archive.open('vault/' + record['path']) as file:
            while chunk := file.read(65536):
                digest.update(chunk)
                size += len(chunk)
        assert digest.hexdigest() == record['hash']
        assert size == record['bytes']
",
        )
        .arg(&target)
        .arg(&manifest)
        .output()
        .unwrap();
    assert!(
        validation.status.success(),
        "独立 ZIP64 校验失败：{}",
        String::from_utf8_lossy(&validation.stderr)
    );
    action(&runtime, json!({"action":"discard"}), vec![])
        .await
        .unwrap();
    action(&runtime, json!({"action":"acknowledge"}), vec![])
        .await
        .unwrap();
    runtime.shutdown().await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "由 test:export:stress 明确执行 2000 次持久运行"]
async fn two_thousand_success_failure_and_cancellation_transactions() {
    let (data, root, out, runtime) = fixture().await;
    let target = out.path().join("result.bin");
    let mut committed = b"original target".to_vec();
    fs::write(&target, &committed).unwrap();
    for index in 0_u32..2000 {
        let control = OperationControl::default();
        prepare(&runtime, root.path(), control.clone()).await;
        let bytes = index.to_le_bytes().to_vec();
        action(
            &runtime,
            json!({"action":"write","path":"result","resource":false}),
            bytes.clone(),
        )
        .await
        .unwrap();
        action(&runtime, json!({"action":"seal"}), vec![])
            .await
            .unwrap();
        action(&runtime, json!({"action":"target","path":target}), vec![])
            .await
            .unwrap();
        match index % 3 {
            0 => {
                action(
                    &runtime,
                    json!({"action":"publish","single":"result"}),
                    vec![],
                )
                .await
                .unwrap();
                committed = bytes;
                assert!(!control.cancel());
            }
            1 => {
                assert!(control.cancel());
                assert!(action(
                    &runtime,
                    json!({"action":"publish","single":"result"}),
                    vec![]
                )
                .await
                .is_err());
            }
            _ => {
                let info = action(&runtime, json!({"action":"info"}), vec![])
                    .await
                    .unwrap();
                fs::write(
                    std::path::Path::new(info["outputDirectory"].as_str().unwrap()).join("result"),
                    b"tampered",
                )
                .unwrap();
                assert!(action(
                    &runtime,
                    json!({"action":"publish","single":"result"}),
                    vec![]
                )
                .await
                .is_err());
            }
        }
        action(&runtime, json!({"action":"discard"}), vec![])
            .await
            .unwrap();
        action(&runtime, json!({"action":"acknowledge"}), vec![])
            .await
            .unwrap();
        assert_eq!(fs::read(&target).unwrap(), committed);
        assert_eq!(fs::read_dir(out.path()).unwrap().count(), 1);
        assert_eq!(
            fs::read_dir(data.path().join("export-jobs"))
                .unwrap()
                .count(),
            1
        );
    }
    assert_eq!(
        fs::read(root.path().join("a.md")).unwrap(),
        "# 原文\n".as_bytes()
    );
    runtime.shutdown().await.unwrap();
}
