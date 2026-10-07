use super::{call, output, tools};
use noemori_agent::AgentSession;
use serde_json::json;

#[tokio::test]
async fn piped_input_preserves_control_bytes_and_explicit_eof_without_a_pty() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(
        &tools,
        &session,
        json!({"action":"exec","cmd":"cat","stdin":true,"yield_time_ms":0}),
    )
    .await;
    assert_eq!(first["status"], "running");
    let text = "你好\0\u{3}\n";
    let done = output(&tools, &session, json!({"action":"interact","session_id":first["session_id"],"input":text,"close_stdin":true,"yield_time_ms":5000})).await;
    assert_eq!(done["exit_code"], 0, "{done:?}");
    assert_eq!(done["output"], text);
    let closed = output(&tools, &session, json!({"action":"interact","session_id":first["session_id"],"close_stdin":true,"yield_time_ms":0})).await;
    assert_eq!(closed["exit_code"], 0);
    let rejected = call(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"input":"late"}),
    )
    .await;
    assert!(rejected.is_error);
    session.close().await.unwrap();
}

#[tokio::test]
async fn pty_size_can_change_and_invalid_half_close_does_not_send_input() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"stty -echo; stty size; IFS= read -r value; printf '%s:' \"$value\"; stty size","tty":true,"size":{"rows":30,"columns":90},"yield_time_ms":1000})).await;
    assert_eq!(
        first["output"].as_str().unwrap().replace('\r', ""),
        "30 90\n"
    );
    let rejected = call(&tools, &session, json!({"action":"interact","session_id":first["session_id"],"input":"bad\n","close_stdin":true})).await;
    assert!(rejected.is_error);
    let resized = output(&tools, &session, json!({"action":"resize","session_id":first["session_id"],"size":{"rows":42,"columns":132}})).await;
    assert_eq!(resized["applied"], true);
    let done = output(&tools, &session, json!({"action":"interact","session_id":first["session_id"],"input":"good\n","yield_time_ms":5000})).await;
    assert_eq!(done["exit_code"], 0, "{done:?}");
    assert_eq!(
        done["output"].as_str().unwrap().replace('\r', ""),
        "good:42 132\n"
    );
    let exited = call(
        &tools,
        &session,
        json!({"action":"resize","session_id":first["session_id"],"size":{"rows":20,"columns":80}}),
    )
    .await;
    assert!(exited.is_error);
    session.close().await.unwrap();
}

#[tokio::test]
async fn piped_process_can_receive_sigint_without_injecting_control_bytes() {
    let tools = tools();
    let session = AgentSession::new();
    let first = output(&tools, &session, json!({"action":"exec","cmd":"trap 'printf interrupted; exit 23' INT; printf ready; while :; do sleep 1; done","stdin":true,"yield_time_ms":1000})).await;
    assert_eq!(first["output"], "ready");
    let resized = call(
        &tools,
        &session,
        json!({"action":"resize","session_id":first["session_id"],"size":{"rows":20,"columns":80}}),
    )
    .await;
    assert!(resized.is_error);
    let signal = output(
        &tools,
        &session,
        json!({"action":"interrupt","session_id":first["session_id"]}),
    )
    .await;
    assert_eq!(signal["applied"], true);
    let done = output(
        &tools,
        &session,
        json!({"action":"interact","session_id":first["session_id"],"yield_time_ms":5000}),
    )
    .await;
    assert_eq!(done["exit_code"], 23, "{done:?}");
    assert!(done["output"].as_str().unwrap().contains("interrupted"));
    session.close().await.unwrap();
}

#[tokio::test]
async fn terminal_dimensions_are_validated_before_any_process_starts() {
    let tools = tools();
    let session = AgentSession::new();
    for args in [
        json!({"action":"exec","cmd":"true","size":{"rows":20,"columns":80}}),
        json!({"action":"exec","cmd":"true","tty":true,"size":{"rows":0,"columns":80}}),
        json!({"action":"exec","cmd":"true","tty":true,"size":{"rows":20,"columns":4097}}),
    ] {
        assert!(call(&tools, &session, args).await.is_error);
    }
    assert_eq!(
        output(&tools, &session, json!({"action":"list"})).await,
        json!({"terminals":[]})
    );
    session.close().await.unwrap();
}
