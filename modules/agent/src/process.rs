//! macOS 的退出过渡态不能靠信号错误码判断，终端与辅助进程共用成员状态检查。

use libproc::{
    libproc::{bsd_info::BSDInfo, proc_pid::pidinfo},
    processes::{ProcFilter, pids_by_type},
};
use nix::unistd::Pid;

/// 检查尚未回收组长的自有进程组是否已无存活成员；不发送信号，也不代替 wait 回收。
/// `group` 必须是守卫仍持有的正进程组 ID；查询失败或成员状态无法确认时返回错误。
pub(crate) fn group_has_no_live_members(group: Pid) -> Result<bool, String> {
    // sys/proc_info.h 的 PROC_FLAG_INEXIT：进程已进入 exit()，即便状态还未变为 SZOMB 也不再接收信号。
    const PROC_FLAG_INEXIT: u32 = 4;
    let pgrpid = u32::try_from(group.as_raw())
        .ok()
        .filter(|id| *id > 0)
        .ok_or("进程组标识无效")?;
    let members = pids_by_type(ProcFilter::ByProgramGroup { pgrpid })
        .map_err(|error| format!("进程组成员查询失败：{error}"))?;
    for pid in members {
        let raw = i32::try_from(pid).map_err(|_| "子进程标识无效")?;
        // XNU 的 PROC_PIDTBSDINFO 用 arg=1 才查询僵尸；覆盖正在退出到僵尸之间的内核过渡态。
        match pidinfo::<BSDInfo>(raw, 1) {
            Ok(info)
                if info.pbi_pgid != pgrpid
                    || info.pbi_status == nix::libc::SZOMB
                    || info.pbi_flags & PROC_FLAG_INEXIT != 0 => {}
            Ok(_) => return Ok(false),
            Err(error) => {
                let remaining = pids_by_type(ProcFilter::ByProgramGroup { pgrpid })
                    .map_err(|error| format!("进程组复查失败：{error}"))?;
                if remaining.contains(&pid) {
                    return Err(format!("子进程状态无法确认：{error}"));
                }
            }
        }
    }
    Ok(true)
}
