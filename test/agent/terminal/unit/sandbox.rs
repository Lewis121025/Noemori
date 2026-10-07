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
        environment: Default::default(),
    };
    let text = "--bind / /; printf '$(ignored)'";
    let target = linux::Target {
        shell: super::super::shell::Invocation::plain(Path::new("/bin/sh"), text),
        cwd: Path::new("/workspace"),
        tty: false,
        network: None,
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
    let separator = args.iter().position(|argument| argument == "--").unwrap();
    assert_eq!(
        &args[separator..separator + 3],
        [OsString::from("--"), "/bin/sh".into(), "-c".into()]
    );
    assert_eq!(
        args.last(),
        Some(&OsString::from(text)),
        "命令须完整保留为独立参数"
    );
    assert_eq!(args.iter().filter(|argument| *argument == text).count(), 1);
    assert!(!args.windows(3).any(|a| a == ["--bind", "/", "/"]));
    let mask = args
        .windows(2)
        .position(|a| a[0] == "--tmpfs" && a[1] == protected)
        .unwrap();
    let workspace = args.iter().position(|a| a == "/workspace").unwrap();
    assert!(mask > workspace, "私有宿主目录必须在工作区挂载之后遮蔽");
    let bin = protected.join("bin");
    let bundled = args
        .windows(3)
        .position(|a| a[0] == "--ro-bind" && a[1] == bin && a[2] == bin)
        .unwrap();
    assert!(bundled > mask, "内置工具须在遮蔽私有目录后以只读方式恢复");
    assert!(
        args.windows(2)
            .any(|a| a[0] == "--remount-ro" && a[1] == protected)
    );
    assert!(args.windows(2).any(|a| a == ["--remount-ro", "/tmp"]));
    assert_eq!(
        &args[mask - 2..mask],
        [OsString::from("--perms"), OsString::from("0111")]
    );
    assert!(!args.windows(3).any(|a| a[0] == "--bind" && a[1] == bin));
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
    policy.writable = vec!["/tmp".into()];
    let (_, args) = linux::command(&policy, protected, &home, &temp, &target).unwrap();
    assert!(
        !args.windows(2).any(|a| a == ["--remount-ro", "/tmp"]),
        "宿主明确授予 /tmp 写权限时不能覆盖授权"
    );
    assert!(
        args.windows(2)
            .any(|a| a[0] == "--remount-ro" && a[1] == protected)
    );
}
