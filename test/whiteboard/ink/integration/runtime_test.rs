use noemori_ink::{LABELS, ShapeClassifier, rasterize, rasterize_paths};
use std::path::Path;

#[test]
fn raster_contract_preserves_direction_aspect_and_translation() {
    let original = [[0.0, 0.0], [100.0, 0.0], [100.0, 40.0]];
    let image = rasterize(&original).unwrap();
    assert_eq!(image.dimensions(), (224, 224));
    assert_eq!(
        image,
        rasterize(&original.into_iter().rev().collect::<Vec<_>>()).unwrap()
    );
    assert_eq!(
        image,
        rasterize(&original.map(|p| [p[0] * 3.0 + 999.0, p[1] * 3.0 - 222.0])).unwrap()
    );
    let dark: Vec<_> = image
        .enumerate_pixels()
        .filter(|(_, _, p)| p[0] < 128)
        .collect();
    let width = dark.iter().map(|p| p.0).max().unwrap() - dark.iter().map(|p| p.0).min().unwrap();
    let height = dark.iter().map(|p| p.1).max().unwrap() - dark.iter().map(|p| p.1).min().unwrap();
    assert!((f64::from(width) / f64::from(height) - 2.5).abs() < 0.1);
}

#[test]
fn raster_rejects_invalid_and_degenerate_samples() {
    for points in [
        vec![],
        vec![[0.0, 0.0]],
        vec![[1.0, 1.0]; 2],
        vec![[0.0, 0.0], [f64::NAN, 1.0]],
        vec![[0.0, 0.0], [10_000_001.0, 1.0]],
    ] {
        assert!(rasterize(&points).is_err());
    }
}

#[test]
fn point_strokes_are_visible_in_grouped_static_images() {
    let first = [[0.0, 0.0]];
    let second = [[100.0, 0.0]];
    let image = rasterize_paths(&[&first, &second]).unwrap();
    assert!(image.get_pixel(16, 112)[0] < 128);
    assert!(image.get_pixel(208, 112)[0] < 128);
    assert_eq!(image.get_pixel(112, 112)[0], 255);
}

#[test]
fn verified_candidate_runs_in_rust_on_native_vectors() {
    let model =
        std::env::var("NOEMORI_INK_MODEL").expect("真实模型集成测试必须提供 NOEMORI_INK_MODEL");
    let mut classifier = ShapeClassifier::load(Path::new(&model)).unwrap();
    let samples = [
        (
            "line",
            (0..100)
                .map(|i| [f64::from(i), (f64::from(i) * 0.2).sin() * 0.5])
                .collect::<Vec<_>>(),
        ),
        (
            "circle",
            (0..=128)
                .map(|i| {
                    let angle = f64::from(i) * std::f64::consts::TAU / 128.0;
                    [angle.cos() * 80.0, angle.sin() * 80.0]
                })
                .collect(),
        ),
    ];
    for (expected, points) in samples {
        let (index, probability) = classifier.classify(&points).unwrap();
        let probabilities = classifier.probabilities(&points).unwrap();
        let evidence = classifier.evidence(&points).unwrap();
        assert_eq!(evidence.primary, probabilities);
        if let Some(refinement) = evidence.refinement {
            assert!((refinement.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        }
        assert!((probabilities.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        assert_eq!(probability, probabilities[index]);
        assert_eq!(LABELS[index], expected);
        assert!(probability > 0.95, "{expected}: {probability}");
    }
}
