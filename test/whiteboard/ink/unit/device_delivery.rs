//! 设备回放必须尊重事件到达顺序，未来批次中的合并样本不能参与此前帧的预测。
use super::*;

#[test]
fn a_later_batch_cannot_change_an_earlier_frame_prediction() {
    let mut timeline = Timeline {
        strokes: vec![DeliveredStroke {
            category: "mouse/test".to_string(),
            origin_ms: 0.0,
            points: vec![[0.0, 0.0, 0.0], [8.0, 0.0, 8.0], [16.0, 0.0, 16.0]],
            eligible: true,
            ended_received_ms: None,
        }],
        batches: vec![
            Batch {
                stroke: 0,
                ended: false,
                points: vec![[0.0, 0.0, 0.0]],
            },
            Batch {
                stroke: 0,
                ended: false,
                points: vec![[8.0, 0.0, 8.0]],
            },
        ],
        frames: vec![Frame {
            callback_ms: 4.0,
            observed_batches: 1,
        }],
    };
    let before = evaluate(&timeline, "baseline");
    timeline.batches[1].points[0][0] = 8000.0;
    assert_eq!(before, evaluate(&timeline, "baseline"));
    assert_eq!(before["groups"]["mouse/test"]["position_error"]["rms"], 4.0);
}

#[test]
fn frames_after_pen_up_are_not_scored_as_active_ink_predictions() {
    let timeline = Timeline {
        strokes: vec![DeliveredStroke {
            category: "pen/test".to_string(),
            origin_ms: 0.0,
            points: vec![[0.0, 0.0, 0.0]],
            eligible: true,
            ended_received_ms: Some(1.0),
        }],
        batches: vec![Batch {
            stroke: 0,
            ended: true,
            points: vec![[0.0, 0.0, 0.0]],
        }],
        frames: vec![Frame {
            callback_ms: 2.0,
            observed_batches: 1,
        }],
    };
    let report = evaluate(&timeline, "baseline");
    assert_eq!(report["ended_frames"], 1);
    assert!(report["groups"].as_object().unwrap().is_empty());
}
