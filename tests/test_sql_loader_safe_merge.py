import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LOADER_PATH = (
    ROOT
    / "pipeline_sagrado"
    / "PIPELINE SAGRADO"
    / "06_CARGA_BDD"
    / "SQLLoader"
    / "scripts"
    / "load_master_to_postgres.py"
)
SPEC = importlib.util.spec_from_file_location("sql_loader", LOADER_PATH)
loader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(loader)


class FakeCursor:
    def __init__(self, dependencies=None, collisions=None, moved_links=1):
        self.dependencies = dependencies or {}
        self.collisions = collisions or []
        self.moved_links = moved_links
        self.results = []
        self.rowcount = 0
        self.commands = []

    def execute(self, query, params=None):
        normalized = " ".join(query.split()).lower()
        self.commands.append((normalized, params))
        if "from information_schema.table_constraints" in normalized:
            self.results = [
                ("public", "distributor_reference_link", "reference_id"),
                ("public", "item", "reference_id"),
            ]
        elif 'from "public"."item"' in normalized:
            ids = params[0]
            self.results = [(value, self.dependencies[value]) for value in ids if self.dependencies.get(value)]
        elif normalized.startswith("delete from public.distributor_reference_link"):
            self.results = [(value,) for value in params[0]]
        elif "from public.distributor_reference_link" in normalized:
            self.results = self.collisions
        elif normalized.startswith("update public.distributor_reference_link"):
            self.results = []
            self.rowcount = self.moved_links
        elif normalized.startswith("delete from public.reference"):
            self.results = [(value,) for value in params[0]]
        else:
            raise AssertionError(f"Unexpected SQL: {normalized}")

    def fetchall(self):
        return list(self.results)


class SafeReferenceMergeTest(unittest.TestCase):
    def test_merges_unreferenced_duplicates_into_lowest_id(self):
        cursor = FakeCursor(moved_links=2)
        result = loader.safely_merge_split_references(cursor, {20, 10})
        self.assertTrue(result["merged"])
        self.assertEqual(result["survivor_reference_id"], 10)
        self.assertEqual(result["merged_reference_ids"], [20])
        self.assertEqual(result["moved_links"], 2)

    def test_preserves_the_only_reference_used_by_business_rows(self):
        cursor = FakeCursor(dependencies={20: 3})
        result = loader.safely_merge_split_references(cursor, {10, 20})
        self.assertTrue(result["merged"])
        self.assertEqual(result["survivor_reference_id"], 20)
        self.assertEqual(result["merged_reference_ids"], [10])

    def test_rejects_merge_when_multiple_references_have_business_rows(self):
        cursor = FakeCursor(dependencies={10: 1, 20: 2})
        result = loader.safely_merge_split_references(cursor, {10, 20})
        self.assertFalse(result["merged"])
        self.assertEqual(result["reason"], "multiple_references_have_business_dependencies")
        self.assertFalse(any(command.startswith("update ") for command, _ in cursor.commands))

    def test_rejects_merge_on_distributor_variant_collision(self):
        collision = [
            (91, 20, 7, "resistencia: 0.8 ohm", "https://supplier.test/a"),
            (92, 10, 7, "resistencia: 0.8 ohm", "https://supplier.test/b"),
        ]
        cursor = FakeCursor(collisions=collision)
        result = loader.safely_merge_split_references(cursor, {10, 20})
        self.assertFalse(result["merged"])
        self.assertEqual(result["reason"], "distributor_variant_collision")
        self.assertFalse(any(command.startswith("update ") for command, _ in cursor.commands))

    def test_deduplicates_identical_links_when_explicitly_enabled(self):
        duplicate = [
            (91, 20, 7, "resistencia: 0.8 ohm", "https://supplier.test/same"),
            (92, 10, 7, "resistencia: 0.8 ohm", "https://supplier.test/same"),
        ]
        cursor = FakeCursor(collisions=duplicate)
        result = loader.safely_merge_split_references(
            cursor,
            {10, 20},
            dedupe_identical_links=True,
        )
        self.assertTrue(result["merged"])
        self.assertEqual(result["survivor_reference_id"], 10)
        self.assertEqual(result["duplicate_links_deleted"], [91])


if __name__ == "__main__":
    unittest.main()
