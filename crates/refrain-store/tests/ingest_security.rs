// Copyright (c) 2026 2youg1
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

mod ingest {
    use refrain_store::ingest::{MAX_SOURCE_BYTES, read_source};

    #[test]
    fn source_size_is_refused_before_allocation() {
        let path = std::env::temp_dir().join(format!(
            "refrain-oversized-{}.html",
            refrain_core::Id::new()
        ));
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(MAX_SOURCE_BYTES + 1).unwrap();
        drop(file);

        let result = read_source(&path);
        std::fs::remove_file(path).unwrap();

        assert!(result.is_err());
    }
}
