use super::*;
#[tokio::test]
async fn process_output_is_bounded_without_waiting_for_eof() {
    let (mut write, read) = tokio::io::duplex(64);
    write.write_all(&[1; 16]).await.unwrap();
    assert!(
        bounded_output(read, 8)
            .await
            .unwrap_err()
            .contains("资源上限")
    );
}

#[tokio::test]
async fn a_control_frame_without_newline_cannot_allocate_past_its_budget() {
    let (mut write, read) = tokio::io::duplex(64);
    write.write_all(&[1; 16]).await.unwrap();
    let mut reader = tokio::io::BufReader::new(read);
    assert!(
        frame_line(&mut reader, 8)
            .await
            .unwrap_err()
            .contains("字节上限")
    );
}
