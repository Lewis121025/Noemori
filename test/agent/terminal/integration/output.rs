use super::{call, output, tools};
use base64::{Engine, engine::general_purpose::STANDARD};
use noemori_agent::AgentSession;
use serde_json::json;

#[tokio::test]
async fn raw_output_replay_preserves_streams_and_every_byte_with_independent_cursors() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({
            "action":"exec",
            "cmd":"printf '\\000\\377\\303'; printf '\\376err' >&2; printf '\\251end'",
            "yield_time_ms":10000
        }),
    )
    .await;
    assert_eq!(first["status"], "exited");
    let mut offset = 0;
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    loop {
        let request = json!({"action":"read_bytes", "session_id":first["session_id"], "offset":offset, "max_output_bytes":2});
        let (page, duplicate) = tokio::join!(
            output(&tools, &session, request.clone()),
            output(&tools, &session, request)
        );
        assert_eq!(page, duplicate);
        let mut count = 0;
        for chunk in page["chunks"].as_array().unwrap() {
            let bytes = STANDARD
                .decode(chunk["data_base64"].as_str().unwrap())
                .unwrap();
            assert_eq!(chunk["offset"], offset + count);
            count += bytes.len() as u64;
            match chunk["stream"].as_str().unwrap() {
                "stdout" => stdout.extend(bytes),
                "stderr" => stderr.extend(bytes),
                stream => panic!("管道输出不能标记为 {stream}"),
            }
            assert_eq!(chunk["next_offset"], offset + count);
        }
        assert!(count <= 2);
        let next = page["next_offset"].as_u64().unwrap();
        assert_eq!(next, offset + count);
        offset = next;
        if page["has_more"] == false {
            break;
        }
        assert!(count > 0);
    }
    assert_eq!(stdout, b"\0\xff\xc3\xa9end");
    assert_eq!(stderr, b"\xfeerr");
    assert_eq!(offset, (stdout.len() + stderr.len()) as u64);
    let invalid = call(
        &tools,
        &session,
        json!({"action":"read_bytes", "session_id":first["session_id"], "offset":offset+1}),
    )
    .await;
    assert!(invalid.is_error);
    session.close().await.unwrap();
}

#[tokio::test]
async fn binary_stdin_is_written_without_utf8_conversion_and_eof_is_explicit() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec", "cmd":"cat", "stdin":true, "yield_time_ms":0}),
    )
    .await;
    let data: Vec<_> = (0..=255).collect();
    let written = output(&tools, &session, json!({"action":"write", "session_id":first["session_id"], "data_base64":STANDARD.encode(&data), "close_stdin":true, "yield_time_ms":10000})).await;
    assert_eq!(written["status"], "exited");
    let replay = output(
        &tools,
        &session,
        json!({"action":"read_bytes", "session_id":first["session_id"]}),
    )
    .await;
    let actual: Vec<_> = replay["chunks"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|chunk| {
            STANDARD
                .decode(chunk["data_base64"].as_str().unwrap())
                .unwrap()
        })
        .collect();
    assert_eq!(actual, data);
    session.close().await.unwrap();
}

#[tokio::test]
async fn truncated_output_can_be_replayed_in_full_without_reexecuting_command() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({
        "action": "exec",
        "cmd": "i=0; while [ $i -lt 2000 ]; do printf '%04d:中文🙂\\n' \"$i\"; i=$((i+1)); done",
        "yield_time_ms": 10000,
        "max_output_chars": 256
    })).await;
    assert_eq!(first["status"], "exited");
    assert_eq!(first["truncated"], true);
    let mut offset = 0;
    let mut transcript = String::new();
    loop {
        let arguments = json!({"action":"read", "session_id":first["session_id"], "offset":offset, "max_output_chars":256});
        let (page, repeated) = tokio::join!(
            output(&tools, &session, arguments.clone()),
            output(&tools, &session, arguments)
        );
        assert_eq!(
            page, repeated,
            "读取游标由调用方持有，多个读者不能互相消耗日志"
        );
        assert_eq!(page["offset"], offset);
        assert!(page["output"].as_str().unwrap().chars().count() <= 256);
        transcript.push_str(page["output"].as_str().unwrap());
        let next = page["next_offset"].as_u64().unwrap();
        assert!(next > offset);
        offset = next;
        if page["has_more"] == false {
            break;
        }
    }
    let expected: String = (0..2000).map(|i| format!("{i:04}:中文🙂\n")).collect();
    assert_eq!(transcript, expected);
    assert_eq!(offset, expected.len() as u64);
    let tail = output(
        &tools,
        &session,
        json!({"action":"read","session_id":first["session_id"],"offset":offset}),
    )
    .await;
    assert_eq!(tail["output"], "");
    assert_eq!(tail["has_more"], false);
    session.close().await.unwrap();
}

#[tokio::test]
async fn replay_checks_session_and_utf8_offsets_and_does_not_consume_live_output() {
    let tools = tools();
    let session = AgentSession::new();
    let started = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf '中🙂'; sleep 30","yield_time_ms":100}),
    )
    .await;
    let id = &started["session_id"];
    let read = output(&tools, &session, json!({"action":"read","session_id":id})).await;
    assert_eq!(read["output"], "中🙂");
    assert_eq!(read["status"], "running");
    let premature = call(
        &tools,
        &session,
        json!({"action":"release","session_id":id}),
    )
    .await;
    assert!(premature.is_error);
    for offset in [1, 4, 100] {
        let invalid = call(
            &tools,
            &session,
            json!({"action":"read","session_id":id,"offset":offset}),
        )
        .await;
        assert!(invalid.is_error, "{invalid:?}");
    }
    let stranger = AgentSession::new();
    let denied = call(&tools, &stranger, json!({"action":"read","session_id":id})).await;
    assert!(denied.is_error);
    let stopped = output(&tools, &session, json!({"action":"stop","session_id":id})).await;
    assert_eq!(stopped["status"], "stopped");
    let replay = output(&tools, &session, json!({"action":"read","session_id":id})).await;
    assert_eq!(replay["output"], "中🙂");
    let released = output(
        &tools,
        &session,
        json!({"action":"release","session_id":id}),
    )
    .await;
    assert_eq!(released["released"], true);
    let gone = call(&tools, &session, json!({"action":"read","session_id":id})).await;
    assert!(gone.is_error);
    session.close().await.unwrap();
    stranger.close().await.unwrap();
}

#[tokio::test]
async fn excessive_output_stops_with_an_explicit_error_and_preserves_the_recorded_prefix() {
    let tools = tools();
    let session = AgentSession::new();
    let result = output(
        &tools,
        &session,
        json!({
            "action":"exec", "cmd":"head -c 67117056 /dev/zero | tr '\\000' x",
            "yield_time_ms":10000, "max_output_chars":256
        }),
    )
    .await;
    assert_eq!(result["status"], "failed", "{result:?}");
    assert!(result["error"].as_str().unwrap().contains("64 MiB"));
    let read = output(
        &tools,
        &session,
        json!({"action":"read", "session_id":result["session_id"], "max_output_chars":256}),
    )
    .await;
    assert_eq!(read["output"], "x".repeat(256));
    assert!(read["total_bytes"].as_u64().unwrap() <= 64 * 1024 * 1024);
    assert!(
        session
            .close()
            .await
            .unwrap_err()
            .to_string()
            .contains("64 MiB")
    );
}

#[tokio::test]
async fn reading_the_final_log_page_allows_completed_records_to_be_reclaimed() {
    let workspace = tempfile::tempdir().unwrap();
    let tools = tools();
    let session = AgentSession::new();
    let mut ids = Vec::new();
    for _ in 0..64 {
        let result = output(&tools, &session, json!({"action":"exec","cmd":"while ! test -f release; do sleep 0.01; done; printf done","workdir":workspace.path(),"yield_time_ms":0})).await;
        assert_eq!(result["status"], "running");
        ids.push(result["session_id"].clone());
    }
    std::fs::write(workspace.path().join("release"), "ready").unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        for id in ids {
            loop {
                let page = output(&tools, &session, json!({"action":"read","session_id":id})).await;
                if page["status"] != "running" {
                    assert_eq!(page["output"], "done");
                    assert_eq!(page["has_more"], false);
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }
    })
    .await
    .unwrap();
    let next = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"printf next"}),
    )
    .await;
    assert_eq!(next["output"], "next");
    session.close().await.unwrap();
}
