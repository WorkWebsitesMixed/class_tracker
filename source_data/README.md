# source_data/

Raw source exports used by the import scripts. The binaries themselves are
**git-ignored** (large, change often) — copy them here manually on each machine,
or pull them from shared Drive.

Expected files:

| File | Produced by | Consumed by |
|------|-------------|-------------|
| `School Calendar 2026-2027.xlsx` | School calendar (month-per-sheet) | `npm run import:calendar` |
| `Horario profes <date>.pdf` | aSc Horarios → PDF export (reference only) | — |
| `schedule.csv` | aSc Horarios → CSV/XML, mapped to the columns in `scripts/README.md` | `npm run import:schedule` |

See `scripts/README.md` for the full import pipeline.
