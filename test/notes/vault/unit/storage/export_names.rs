use super::name_key;

#[test]
fn canonical_caseless_names_match_mac_filesystem_collisions() {
    for (source, expected) in [
        ("straße.md", "strasse.md"),
        ("STRASSE.md", "strasse.md"),
        ("Σ.md", "σ.md"),
        ("ς.md", "σ.md"),
        ("ſ.md", "s.md"),
        ("ı.md", "ı.md"),
        ("I.md", "i.md"),
        ("é.md", "e\u{301}.md"),
        ("\u{212b}.md", "a\u{30a}.md"),
        ("📝/中文.md", "📝/中文.md"),
    ] {
        assert_eq!(name_key(source), expected);
    }
}
