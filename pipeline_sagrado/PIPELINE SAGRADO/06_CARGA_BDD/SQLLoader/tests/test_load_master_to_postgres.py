import importlib.util
import os
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "load_master_to_postgres.py"
sys.modules.setdefault("psycopg", types.ModuleType("psycopg"))
SPEC = importlib.util.spec_from_file_location("load_master_to_postgres", SCRIPT)
loader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(loader)


class FakeCursor:
    def __init__(self, returned=None):
        self.returned = returned or []
        self.query = None
        self.params = None

    def execute(self, query, params=None):
        self.query = query
        self.params = params

    def fetchall(self):
        return self.returned


class LoaderBatchTests(unittest.TestCase):
    def test_reference_and_link_ids_are_left_to_postgres(self):
        record = {
            "_source_key": "only_vaperalia:1",
            "_db_sku": "SKU-1",
            "_db_ean13": None,
            "title": "Producto",
        }
        reference = loader.reference_tuple(record)
        link = loader.link_tuple(
            record,
            "vaperalia",
            {"url": "https://example.test/p", "reference": "REF", "title": "Producto"},
            "master_record",
        )

        self.assertIsNone(reference[loader.REFERENCE_ID])
        self.assertIsNone(link[loader.LINK_ID])
        self.assertEqual("vaperalia", link[loader.LINK_DISTRIBUIDORA_ID])
        self.assertIsNone(link[loader.LINK_REFERENCIA_ID])

    def test_execute_values_builds_one_multirow_statement(self):
        cursor = FakeCursor(returned=[(101,), (102,)])
        returned = loader.execute_values(
            cursor,
            "insert into t (a, b) values ",
            [(1, "a"), (2, "b")],
            " returning a",
            returning=True,
        )

        self.assertIn("(%s,%s),(%s,%s)", cursor.query)
        self.assertEqual([1, "a", 2, "b"], cursor.params)
        self.assertEqual([(101,), (102,)], returned)

    def test_batch_size_is_applied_and_capped_by_postgres_parameter_limit(self):
        rows = [(value,) for value in range(7)]
        self.assertEqual([3, 3, 1], [len(batch) for batch in loader.iter_batches(rows, 3, 1)])
        wide_rows = [tuple(range(30001)), tuple(range(30001))]
        self.assertEqual([1, 1], [len(batch) for batch in loader.iter_batches(wide_rows, 1000, 30001)])

    def test_existing_identity_is_preserved_and_new_conflicts_are_normalized(self):
        existing = [(7, "SKU-EXISTENTE", "123")]
        kept = {
            "record": {"_source_key": "matched_both:kept"},
            "resolved_reference_id": 7,
            "reference": self._reference(7, "SKU-EXISTENTE", "123"),
        }
        new = {
            "record": {"_source_key": "only_vaperalia:new"},
            "resolved_reference_id": None,
            "reference": self._reference(None, "SKU-EXISTENTE", "123"),
        }
        stats = {"existing_skus_renamed": 0, "existing_eans_set_null": 0}

        loader.prepare_reference_uniques([kept, new], existing, stats)

        self.assertEqual(7, kept["reference"][loader.REFERENCE_ID])
        self.assertEqual("SKU-EXISTENTE", kept["reference"][loader.REFERENCE_SKU])
        self.assertIsNone(new["reference"][loader.REFERENCE_ID])
        self.assertNotEqual("SKU-EXISTENTE", new["reference"][loader.REFERENCE_SKU])
        self.assertIsNone(new["reference"][loader.REFERENCE_EAN13])
        self.assertEqual(1, stats["existing_skus_renamed"])
        self.assertEqual(1, stats["existing_eans_set_null"])

    def test_database_env_file_is_converted_without_logging_credentials(self):
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write(
                "DB_URL=jdbc:postgresql://db.example.test/catalog?sslmode=require&channelBinding=require\n"
                "DB_USER=user@example.test\n"
                "DB_PASSWORD=p@ss word\n"
            )
            env_path = handle.name
        try:
            with patch.dict(os.environ, {"DATABASE_ENV_FILE": env_path}, clear=True):
                url = loader.resolve_database_url()
            self.assertEqual(
                "postgresql://user%40example.test:p%40ss%20word@db.example.test/catalog?sslmode=require&channel_binding=require",
                url,
            )
        finally:
            Path(env_path).unlink(missing_ok=True)

    @staticmethod
    def _reference(reference_id, sku, ean):
        values = [None] * 22
        values[loader.REFERENCE_ID] = reference_id
        values[loader.REFERENCE_SKU] = sku
        values[loader.REFERENCE_EAN13] = ean
        return tuple(values)


if __name__ == "__main__":
    unittest.main()
