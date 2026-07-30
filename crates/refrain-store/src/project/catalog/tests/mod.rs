use std::fs;

use refrain_core::Id;

use super::{DocumentPageQuery, ProjectStore, fingerprint_of};
use crate::project::RootLocator;
use crate::root::RootKind;
use crate::schema::{AppDb, Database};

#[test]
fn catalog_identity_ignores_scan_order_and_generated_ids() {
    let first = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let reversed_with_new_ids = [
        ["id-3".into(), "资料/乙.md".into(), "material".into()],
        ["id-4".into(), "甲.md".into(), "chapter".into()],
    ];

    assert_eq!(
        fingerprint_of(&first),
        fingerprint_of(&reversed_with_new_ids)
    );
}

/// A real membership change must alter the identity; otherwise the previous
/// test would also pass for a constant function.
#[test]
fn duplicate_paths_would_cancel_out_so_the_scan_must_not_produce_them() {
    // 这条不是在测 fingerprint_of 的正确性，而是钉住它依赖的那个前提。
    //
    // 指纹用异或合并各条目的哈希，好处是与扫描顺序无关（目录遍历次序由文件系统
    // 决定，不能依赖），代价是它对成对出现的相同条目不敏感——两次会互相抵消。
    // 因此如果哪天扫描开始吐重复路径，指纹会把「多了一对重复」看成「什么都没变」。
    //
    // 前提成立的依据：reconcile_documents 把扫描结果灌进 refreshed_documents，
    // 那张表以 path 作 PRIMARY KEY，重复路径根本进不去；documents 表同样以 path
    // 为唯一键。这条测试把「一对重复会抵消」这个事实写在明处，使前提一旦被打破
    // 就有人看得见，而不是留一句注释里的断言。
    let doubled = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "甲.md".into(), "chapter".into()],
    ];
    assert_eq!(super::fingerprint_of(&doubled), [0u8; 32]);
}

#[test]
fn catalog_identity_follows_every_real_change() {
    let base = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let identity = fingerprint_of(&base);

    let renamed: [[String; 3]; 2] = [
        ["id-1".into(), "甲改.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let re_roled: [[String; 3]; 2] = [
        ["id-1".into(), "甲.md".into(), "material".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
    ];
    let removed: [[String; 3]; 1] = [["id-1".into(), "甲.md".into(), "chapter".into()]];
    let added: [[String; 3]; 3] = [
        ["id-1".into(), "甲.md".into(), "chapter".into()],
        ["id-2".into(), "资料/乙.md".into(), "material".into()],
        ["id-3".into(), "丙.md".into(), "chapter".into()],
    ];

    assert_ne!(
        identity,
        fingerprint_of(&renamed),
        "rename was not observed"
    );
    assert_ne!(
        identity,
        fingerprint_of(&re_roled),
        "role change was not observed"
    );
    assert_ne!(
        identity,
        fingerprint_of(&removed),
        "removal was not observed"
    );
    assert_ne!(
        identity,
        fingerprint_of(&added),
        "addition was not observed"
    );
}

/// An unchanged tree must not write another row.
///
/// `total_changes()` counts rows written by this connection and does not
/// benefit from SQLite's page cache. It therefore proves the skip directly.
#[test]
fn an_unchanged_catalog_skips_sql_reconciliation() {
    let root = std::env::temp_dir().join(format!("refrain-catalog-{}", Id::new()));
    fs::create_dir_all(&root).unwrap();
    fs::write(root.join("chapter.md"), "Text.\n").unwrap();
    let mut app = crate::schema::open_in_memory().unwrap();
    AppDb::migrate(&mut app).unwrap();
    let (mut store, _) = ProjectStore::adopt(
        &mut app,
        &RootLocator {
            path: root.clone(),
            kind: RootKind::Folder,
        },
    )
    .unwrap();

    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 1,
        })
        .unwrap();
    let first_changes = store.db.total_changes();
    store
        .refresh_document_page(DocumentPageQuery {
            after: None,
            limit: 1,
        })
        .unwrap();

    assert_eq!(store.db.total_changes(), first_changes);
    drop(store);
    drop(app);
    fs::remove_dir_all(root).unwrap();
}
