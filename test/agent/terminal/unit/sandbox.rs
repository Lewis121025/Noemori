use super::{NetworkAccess, Permissions, linux};
use std::{ffi::OsString, path::Path};

#[test]
fn linux_plan_requires_isolation_and_keeps_model_text_out_of_launcher_options() {
    let protected = Path::new("/tmp/private");
    let home = protected.join("command/home");
    let temp = protected.join("command/tmp");
    let mut policy = Permissions {
        readable: vec!["/usr".into()],
        writable: vec!["/workspace".into()],
        network: NetworkAccess::Denied,
    };
    let text = "--bind / /; printf '$(ignored)'";
    let target = linux::Target {
        shell: Path::new("/bin/sh"),
        cwd: Path::new("/workspace"),
        command: text,
        tty: false,
    };
    let (_, args) = linux::command(&policy, protected, &home, &temp, &target).unwrap();
    for required in [
        "--unshare-user",
        "--unshare-pid",
        "--unshare-net",
        "--unshare-ipc",
        "--disable-userns",
        "--assert-userns-disabled",
        "--die-with-parent",
        "--new-session",
    ] {
        assert!(args.contains(&OsString::from(required)));
    }
    assert!(!args.contains(&OsString::from("--share-net")));
    assert!(
        !args
            .iter()
            .any(|arg| arg.to_string_lossy().ends_with("-try"))
    );
    assert_eq!(
        &args[args.len() - 4..],
        [
            OsString::from("--"),
            "/bin/sh".into(),
            "-c".into(),
            text.into()
        ]
    );
    assert!(!args.windows(3).any(|a| a == ["--bind", "/", "/"]));
    let mask = args
        .windows(2)
        .position(|a| a[0] == "--tmpfs" && a[1] == protected)
        .unwrap();
    let workspace = args.iter().position(|a| a == "/workspace").unwrap();
    assert!(mask > workspace, "私有宿主目录必须在工作区挂载之后遮蔽");
    let scratch = args
        .windows(2)
        .position(|a| a == ["--tmpfs", "/tmp"])
        .unwrap();
    assert!(scratch < workspace, "临时挂载不能遮蔽位于 /tmp 内的工作区");
    assert!(
        !args
            .windows(3)
            .any(|a| a[0] == "--bind" && a[1] == temp && a[2] == "/tmp")
    );
    policy.network = NetworkAccess::Allowed;
    let (_, args) = linux::command(&policy, protected, &home, &temp, &target).unwrap();
    assert!(args.contains(&OsString::from("--share-net")));
}
