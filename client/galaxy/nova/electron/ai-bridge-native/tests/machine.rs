use ai_bridge_native::pool::machine::{fingerprint_from, fingerprint_of, machine_fingerprint, usable_machine_id};

// 设备指纹决定 Hub 把工作室的信誉记在哪。两种错都很贵：同一台机器算出两个指纹，重新配对就清零；
// 不同机器算出同一个指纹，一台机器造假，另一台跟着被扣分。

#[test]
fn the_same_machine_always_gets_the_same_fingerprint() {
    let dir = tempfile::tempdir().unwrap();
    let first = machine_fingerprint(dir.path()).expect("本机算得出指纹");
    assert_eq!(first.len(), 64);
    assert_eq!(machine_fingerprint(dir.path()), Some(first));
}

#[test]
fn the_raw_machine_id_never_leaves_the_machine() {
    let raw = "c7a1f0e2-2b1d-4a37-9d8e-1f2a3b4c5d6e";
    let hashed = fingerprint_of(raw);
    assert_eq!(hashed, fingerprint_of(raw), "同一个 id 每次都得算出同一个指纹");
    assert!(!hashed.contains("c7a1f0e2"), "上报的只能是哈希");
}

#[test]
fn without_a_system_id_the_fallback_survives_re_pairing_in_the_same_install() {
    let install = tempfile::tempdir().unwrap();
    let first = fingerprint_from(None, install.path()).expect("兜底 id 写得进运行目录");
    // 重新配对只换令牌文件，运行目录还在：兜底 id 读回来，指纹不变。
    assert_eq!(fingerprint_from(None, install.path()), Some(first.clone()));

    let reinstalled = tempfile::tempdir().unwrap();
    assert_ne!(fingerprint_from(None, reinstalled.path()), Some(first), "换一份安装就认不出了，这是兜底的极限");
}

#[test]
fn a_system_id_wins_over_the_fallback_file() {
    let dir = tempfile::tempdir().unwrap();
    let id = "4c4c4544-0042-3510-8052-b3c04f4d4e32".to_string();
    assert_eq!(fingerprint_from(Some(id.clone()), dir.path()), Some(fingerprint_of(&id)));
    assert!(!dir.path().join("machine-id").exists(), "拿得到系统 id 就不该写兜底文件");
}

#[test]
fn shared_placeholder_ids_are_not_fingerprints() {
    // 这些值在很多台机器上一模一样，认下来会把不相干的机器的信誉搅在一起。
    for placeholder in [
        "",
        "   \n",
        "00000000-0000-0000-0000-000000000000",
        "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF",
        "03000200-0400-0500-0006-000700080009",
        "abc123",
    ] {
        assert_eq!(usable_machine_id(placeholder), None, "{placeholder:?}");
    }
    assert_eq!(
        usable_machine_id("  4C4C4544-0042-3510-8052-B3C04F4D4E32\n").as_deref(),
        Some("4c4c4544004235108052b3c04f4d4e32"),
        "大小写、连字符、首尾空白不同的同一个 id 要规整成一样的",
    );
}
