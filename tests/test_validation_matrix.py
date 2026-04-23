from __future__ import annotations

from pathlib import Path

from scripts.check_validation_matrix import validate_matrix


def test_validation_matrix_accepts_claim_table(tmp_path: Path) -> None:
    matrix = tmp_path / "validation-matrix.md"
    _ = matrix.write_text(
        "\n".join(
            [
                "# Validation Matrix",
                "",
                "| Claim ID | Status | Validation Commands / Tests |",
                "| --- | --- | --- |",
                "| demo-fast-path | supported | `npm run test:browser` |",
                "| cloud-proxy-auth | partial | `npm run test:node` |",
            ]
        ),
        encoding="utf-8",
    )

    assert validate_matrix(matrix) == []


def test_validation_matrix_rejects_duplicate_ids_and_bad_status(tmp_path: Path) -> None:
    matrix = tmp_path / "validation-matrix.md"
    _ = matrix.write_text(
        "\n".join(
            [
                "| Claim ID | Status | Validation Commands / Tests |",
                "| --- | --- | --- |",
                "| demo-fast-path | supported | `npm run test:browser` |",
                "| demo-fast-path | maybe |  |",
            ]
        ),
        encoding="utf-8",
    )

    errors = validate_matrix(matrix)

    assert "row 2: duplicate claim_id demo-fast-path" in errors
    assert "row 2: invalid status maybe" in errors
    assert "row 2: missing validation commands/tests" in errors
