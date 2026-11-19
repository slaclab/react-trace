# Correlation test fixtures

Every file here but `correlation-links.json` is byte-pinned: a test asserts
its sha256, so a change to a file is a contract change. Prettier skips this
directory (`.prettierignore`); never reformat these files.

- `table-spec-*.json`, `table-result-*.json`: the canopy server's table
  formula contract. They are byte copies of the fixtures that canopy's
  `tests/canopy/fox/test_table_contract.py` pins with the same digests
  (`FIXTURE_SHA256`). `spec.test.ts` checks that the spec builder writes
  these specs and that the result shapes parse.
- `orm-frame.json`, `golden.json`: the statistics oracle. `orm-frame.json` is
  an orbit-response table frame (one corrector as X, four BPMs as Y) with
  missing cells; `golden.json` holds numpy's statistics of it (n, mean, sample std,
  r, R², slope, intercept per Y). `scripts/make_orm_fixture.py` generates both
  and reproduces them byte for byte. `stats.test.ts` checks the closed-form
  statistics against the goldens at 1e-9 and the metric presets against the
  closed form.

- `correlation-links.json`: Correlation's link format v1, recorded links and
  the states they decode to. `query.baseFixtures.test.ts` checks each link
  decodes to its state and re-encodes byte for byte. A fixture is never edited
  to make a refactor pass.

Only the `table-*` files are pinned outside this repository, by canopy.
