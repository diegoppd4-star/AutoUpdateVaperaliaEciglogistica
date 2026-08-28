#!/usr/bin/env python
import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qsl, quote, urlencode, urlsplit, urlunsplit

ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / "input_master"
PREPARED_DIR = INPUT_DIR / "prepared"
RUN_DIR = ROOT / "run_output"
LOG_DIR = ROOT / "logs"
VENDOR_DIR = ROOT / "vendor"

sys.path.insert(0, str(VENDOR_DIR))
try:
    import psycopg  # noqa: E402
except ModuleNotFoundError:
    psycopg = None

DISTRIBUIDORAS = {
    "eciglogistica": {
        "nombre": "Eciglogistica",
        "tiempo_entrega_default_dias": 0,
    },
    "vaperalia": {
        "nombre": "Vaperalia",
        "tiempo_entrega_default_dias": 0,
    },
}


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")


def read_env_file(path):
    values = {}
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def resolve_database_url():
    direct = os.environ.get("DATABASE_URL")
    if direct:
        return direct

    env_file = os.environ.get("DATABASE_ENV_FILE")
    if not env_file:
        return None
    values = read_env_file(env_file)
    jdbc_url = values.get("DB_URL", "")
    user = values.get("DB_USER", "")
    password = values.get("DB_PASSWORD", "")
    if not jdbc_url or not user or not password:
        raise RuntimeError("DATABASE_ENV_FILE no contiene DB_URL, DB_USER y DB_PASSWORD.")

    postgres_url = jdbc_url.removeprefix("jdbc:")
    parsed = urlsplit(postgres_url)
    query = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=True):
        query.append(("channel_binding" if key == "channelBinding" else key, value))
    netloc = f"{quote(user, safe='')}:{quote(password, safe='')}@{parsed.hostname or ''}"
    if parsed.port:
        netloc += f":{parsed.port}"
    return urlunsplit((parsed.scheme, netloc, parsed.path, urlencode(query), parsed.fragment))


def trunc(value, max_len):
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:max_len]


def nullable_text(value):
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def parse_float(value):
    text = str(value or "").strip().lower().replace(",", ".")
    if not text:
        return None
    match = __import__("re").search(r"(\d+(?:\.\d+)?)", text)
    if not match:
        return None
    try:
        return float(match.group(1))
    except ValueError:
        return None


def category_for(record):
    source = " ".join([
        str(record.get("category") or ""),
        str(record.get("sourceCategories") or ""),
        str(record.get("productType") or ""),
        str(record.get("typeGroup") or ""),
    ]).lower()
    if "desech" in source or "disposable" in source:
        return "DESECHABLES"
    if "coil" in source or "resistencia" in source:
        return "RESISTENCIAS"
    if "aroma" in source or "alquimia" in source or "concentrate" in source:
        return "ALQUIMIAS"
    if "nicotine" in source or "nicotina" in source or "pouch" in source or "sales" in source:
        return "NICOTINA"
    if "eliquid" in source or "liquid" in source or "líquido" in source or "liquido" in source:
        return "LIQUIDOS"
    if any(token in source for token in ["kit_device", "mod_device", "pod_replacement", "atomizer_tank", "pyrex"]):
        return "MAQUINAS"
    return "OTROS"


def size_for(record):
    for key in ["tamano", "variantLabel", "variantSignature", "capacidad", "contenido_ml", "bote_ml", "resistencia", "effective_color", "color"]:
        value = nullable_text(record.get(key))
        if value:
            return trunc(value, 120)
    return "unidad"


def clean_ean(value):
    text = str(value or "").strip().replace(" ", "")
    if text.endswith(".0"):
        text = text[:-2]
    if not text:
        return None
    if len(text) > 13:
        return None
    return text


def make_unique_skus(records):
    bases = []
    for record in records:
        base = nullable_text(record.get("sku")) or nullable_text(record.get("reference")) or record["_source_key"]
        bases.append(base)
    counts = Counter(bases)
    unique = {}
    changed = []
    for record, base in zip(records, bases):
        if counts[base] == 1 and len(base) <= 120:
            sku = base
        else:
            suffix = hashlib.sha256(record["_source_key"].encode("utf-8")).hexdigest()[:12]
            head = base[: max(1, 120 - len(suffix) - 1)]
            sku = f"{head}-{suffix}"
            changed.append({"source_key": record["_source_key"], "source_sku": base, "db_sku": sku})
        if sku in unique:
            suffix = hashlib.sha256((record["_source_key"] + ":dedupe").encode("utf-8")).hexdigest()[:12]
            sku = f"{sku[:107]}-{suffix}"
        unique[sku] = record["_source_key"]
        record["_db_sku"] = sku
    return changed


def apply_unique_eans(records):
    values = [clean_ean(record.get("ean13")) for record in records]
    counts = Counter(v for v in values if v)
    duplicate_eans = sorted([ean for ean, count in counts.items() if count > 1])
    invalid_or_duplicate = []
    for record, ean in zip(records, values):
        if ean and counts[ean] == 1:
            record["_db_ean13"] = ean
        else:
            record["_db_ean13"] = None
            if ean:
                invalid_or_duplicate.append({"source_key": record["_source_key"], "ean13": ean})
    return duplicate_eans, invalid_or_duplicate


def url_without_fragment(url):
    return str(url or "").split("#", 1)[0]


def read_prepared_variants(path: Path):
    if not path.exists():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def build_url_index(rows):
    exact = defaultdict(list)
    base = defaultdict(list)
    for row in rows:
        url = row.get("url") or ""
        if url:
            exact[url].append(row)
            base[url_without_fragment(url)].append(row)
    return exact, base


def resolve_by_url(url, exact_index, base_index):
    if not url:
        return None, "no_url"
    if len(exact_index.get(url, [])) == 1:
        return exact_index[url][0], "exact_url"
    no_fragment = url_without_fragment(url)
    if len(base_index.get(no_fragment, [])) == 1:
        return base_index[no_fragment][0], "single_base_url"
    return None, "unresolved"


def row_for_link(record, side, vaperalia_index=None):
    if side == "eciglogistica":
        return record, "master_record"
    if record.get("classification") == "matched_both":
        url = record.get("vaperalia_url") or ""
        resolved, resolution = resolve_by_url(url, vaperalia_index[0], vaperalia_index[1])
        if resolved:
            return resolved, resolution
        fallback = {
            "distributor": "Vaperalia",
            "url": url,
            "baseUrl": url_without_fragment(url),
            "title": record.get("vaperalia_url") or record.get("title") or "",
            "description": "",
            "brand": "",
            "brandCandidates": "",
            "breadcrumbPath": "",
            "metaDescription": "",
            "reference": "",
            "syntheticReference": "",
            "priceTaxExcluded": "",
            "variantSignature": "",
            "variantLabel": "",
            "color": "",
            "reference_color": "",
            "derived_reference_color": "",
            "variantsJson": "{}",
        }
        return fallback, resolution
    return record, "master_record"


def link_variant(row, record):
    value = (
        nullable_text(row.get("variantLabel"))
        or nullable_text(row.get("variantSignature"))
        or nullable_text(record.get("variantLabel"))
        or nullable_text(record.get("variantSignature"))
        or nullable_text(row.get("reference"))
        or "unidad"
    )
    return trunc(value, 255)


def reference_tuple(record):
    return (
        None,
        trunc(record.get("baseKey"), 160),
        trunc(record.get("base_ratio"), 40),
        parse_float(record.get("bote_ml")),
        trunc(record.get("cafeina"), 80),
        parse_float(record.get("capacidad")) or parse_float(record.get("contenido_ml")) or parse_float(record.get("bote_ml")),
        category_for(record),
        trunc(record.get("effective_color") or record.get("reference_color") or record.get("color"), 80),
        parse_float(record.get("contenido_ml")),
        record.get("_db_ean13"),
        trunc(record.get("productLine"), 120),
        trunc(record.get("brand"), 120),
        trunc(record.get("commercialBrand"), 120),
        1,
        parse_float(record.get("nicotina")),
        trunc(record.get("title") or record.get("baseTitle") or record["_source_key"], 160),
        trunc(record.get("resistencia"), 80),
        trunc(record.get("pod_type"), 40),
        trunc(record.get("productType"), 80),
        trunc(record.get("sabor"), 160),
        size_for(record),
        record["_db_sku"],
    )


LINK_ID = 0
LINK_URL = 19
LINK_VARIANTE = 21
LINK_DISTRIBUIDORA_ID = 23
LINK_REFERENCIA_ID = 24
REFERENCE_ID = 0
REFERENCE_EAN13 = 9
REFERENCE_SKU = 21


def link_tuple(record, side, row, resolution):
    url = row.get("url") or (record.get("eciglogistica_url") if side == "eciglogistica" else record.get("vaperalia_url")) or ""
    variant = link_variant(row, record)
    return (
        None,
        True,
        trunc(row.get("baseUrl") or url_without_fragment(url), 2048),
        nullable_text(row.get("brandCandidates")),
        nullable_text(row.get("breadcrumbPath")),
        None,
        trunc(row.get("derived_reference_color"), 255),
        nullable_text(row.get("description")),
        parse_float(record.get("matchConfidence")),
        nullable_text(record.get("reason") or record.get("matchStatus")),
        nullable_text(row.get("metaDescription")),
        parse_float(row.get("priceTaxExcluded")),
        trunc(row.get("reference_color"), 255),
        datetime.now(timezone.utc),
        trunc(row.get("brand"), 255),
        trunc(row.get("reference"), 255),
        trunc(row.get("title") or record.get("title"), 255),
        trunc(row.get("syntheticReference"), 255),
        datetime.now(timezone.utc),
        trunc(url, 2048),
        trunc(row.get("variantSignature"), 255),
        variant,
        nullable_text(row.get("variantsJson")),
        side,
        None,
    )


def load_records():
    records = []
    specs = [
        ("master_matched_both.json", "matched_both"),
        ("master_only_eciglogistica.json", "only_eciglogistica"),
        ("master_only_vaperalia.json", "only_vaperalia"),
    ]
    for file_name, kind in specs:
        for record in read_json(INPUT_DIR / file_name):
            record = dict(record)
            record["_source_file"] = file_name
            record["_source_kind"] = kind
            record["_source_key"] = f"{kind}:{record.get('id')}"
            records.append(record)
    return records


def build_payload():
    records = load_records()
    sku_changes = make_unique_skus(records)
    duplicate_eans, ean_nulls = apply_unique_eans(records)

    vaperalia_rows = read_prepared_variants(PREPARED_DIR / "vaperalia__output.variants.csv")
    vaperalia_index = build_url_index(vaperalia_rows)

    referencias = [reference_tuple(record) for record in records]
    links = []
    load_items = []
    unresolved_vaperalia = []
    for record in records:
        item_links = []
        if record["_source_kind"] in ("matched_both", "only_eciglogistica"):
            row, resolution = row_for_link(record, "eciglogistica")
            link = link_tuple(record, "eciglogistica", row, resolution)
            links.append(link)
            item_links.append(link)
        if record["_source_kind"] in ("matched_both", "only_vaperalia"):
            row, resolution = row_for_link(record, "vaperalia", vaperalia_index)
            if record["_source_kind"] == "matched_both" and resolution == "unresolved":
                unresolved_vaperalia.append({"id": record.get("id"), "url": record.get("vaperalia_url")})
            link = link_tuple(record, "vaperalia", row, resolution)
            links.append(link)
            item_links.append(link)
        load_items.append({
            "record": record,
            "reference": reference_tuple(record),
            "links": item_links,
        })

    return {
        "records": records,
        "referencias": referencias,
        "links": links,
        "load_items": load_items,
        "sku_changes": sku_changes,
        "duplicate_eans": duplicate_eans,
        "ean_nulls": ean_nulls,
        "unresolved_vaperalia": unresolved_vaperalia,
    }


def run_ean_enrichment():
    script = ROOT / "scripts" / "enrich-master-ean13.js"
    node = os.environ.get("NODE_PATH") or shutil.which("node")
    if not node:
        windows_node = Path(r"C:\Users\diego\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe")
        node = str(windows_node) if windows_node.exists() else ""
    if not script.exists() or not node:
        return {"ran": False, "reason": "script_or_node_missing"}
    result = subprocess.run([str(node), str(script)], cwd=str(ROOT), text=True, capture_output=True)
    return {
        "ran": True,
        "returncode": result.returncode,
        "stdout": result.stdout,
        "stderr": result.stderr,
    }


def link_with_distributor(link, distributor_ids):
    values = list(link)
    distributor_key = values[LINK_DISTRIBUIDORA_ID]
    values[LINK_DISTRIBUIDORA_ID] = distributor_ids[distributor_key]
    return tuple(values)


def link_with_reference(link, referencia_id):
    values = list(link)
    values[LINK_REFERENCIA_ID] = referencia_id
    return tuple(values)


def iter_batches(rows, batch_size, column_count):
    safe_size = max(1, int(batch_size))
    safe_size = min(safe_size, max(1, 60000 // max(1, column_count)))
    for offset in range(0, len(rows), safe_size):
        yield rows[offset:offset + safe_size]


def execute_values(cur, prefix, rows, suffix="", returning=False):
    if not rows:
        return []
    width = len(rows[0])
    if any(len(row) != width for row in rows):
        raise ValueError("Todas las filas de un batch deben tener la misma anchura.")
    placeholders = ",".join(
        "(" + ",".join(["%s"] * width) + ")"
        for _ in rows
    )
    params = [value for row in rows for value in row]
    cur.execute(prefix + placeholders + suffix, params)
    return cur.fetchall() if returning else []


def resolve_distributor_ids(cur):
    rows = [
        (data["nombre"], data["tiempo_entrega_default_dias"])
        for data in DISTRIBUIDORAS.values()
    ]
    returned = execute_values(
        cur,
        """
        insert into public.distributor (name, default_delivery_days)
        values
        """,
        rows,
        """
        on conflict (name) do update set name = excluded.name
        returning distributor_id, name
        """,
        returning=True,
    )
    by_name = {name: row_id for row_id, name in returned}
    result = {}
    for key, data in DISTRIBUIDORAS.items():
        if data["nombre"] not in by_name:
            raise RuntimeError(f"No se pudo resolver distribuidora: {data['nombre']}")
        result[key] = by_name[data["nombre"]]
    return result


def load_existing_link_index(cur, distributor_ids):
    cur.execute(
        """
        select distributor_reference_link_id, reference_id, distributor_id, url, variant
        from public.distributor_reference_link
        where distributor_id = any(%s)
        """,
        (list(distributor_ids.values()),),
    )
    result = defaultdict(list)
    for row in cur.fetchall():
        data = {
            "id": row[0],
            "referencia_id": row[1],
            "distribuidora_id": row[2],
            "url": row[3],
            "variante": row[4],
        }
        result[(data["distribuidora_id"], data["url"], data["variante"])].append(data)
    return result


def quote_identifier(value):
    return '"' + str(value).replace('"', '""') + '"'


def reference_dependency_counts(cur, reference_ids):
    """Count non-catalog rows that would prevent safely consolidating references."""
    cur.execute(
        """
        select tc.table_schema, tc.table_name, kcu.column_name
        from information_schema.table_constraints tc
        join information_schema.key_column_usage kcu
          on kcu.constraint_schema = tc.constraint_schema
         and kcu.constraint_name = tc.constraint_name
        join information_schema.referential_constraints rc
          on rc.constraint_schema = tc.constraint_schema
         and rc.constraint_name = tc.constraint_name
        join information_schema.constraint_column_usage ccu
          on ccu.constraint_schema = rc.unique_constraint_schema
         and ccu.constraint_name = rc.unique_constraint_name
        where tc.constraint_type = 'FOREIGN KEY'
          and ccu.table_schema = 'public'
          and ccu.table_name = 'reference'
          and ccu.column_name = 'reference_id'
        order by tc.table_schema, tc.table_name, kcu.column_name
        """
    )
    counts = Counter()
    details = []
    for schema, table, column in cur.fetchall():
        if schema == "public" and table == "distributor_reference_link" and column == "reference_id":
            continue
        cur.execute(
            f"select {quote_identifier(column)}, count(*) "
            f"from {quote_identifier(schema)}.{quote_identifier(table)} "
            f"where {quote_identifier(column)} = any(%s) "
            f"group by {quote_identifier(column)}",
            (list(reference_ids),),
        )
        for reference_id, row_count in cur.fetchall():
            counts[reference_id] += row_count
            details.append({
                "schema": schema,
                "table": table,
                "column": column,
                "reference_id": reference_id,
                "rows": row_count,
            })
    return counts, details


def safely_merge_split_references(cur, reference_ids, dedupe_identical_links=False):
    """Consolidate proven matches only when business FK usage makes the merge unambiguous."""
    reference_ids = sorted(set(reference_ids))
    dependency_counts, dependency_details = reference_dependency_counts(cur, reference_ids)
    referenced_ids = sorted(reference_id for reference_id in reference_ids if dependency_counts[reference_id])
    if len(referenced_ids) > 1:
        return {
            "merged": False,
            "reason": "multiple_references_have_business_dependencies",
            "dependencies": dependency_details,
        }

    survivor_id = referenced_ids[0] if referenced_ids else reference_ids[0]
    merged_ids = [reference_id for reference_id in reference_ids if reference_id != survivor_id]
    cur.execute(
        """
        select distributor_reference_link_id, reference_id, distributor_id, variant, url
        from public.distributor_reference_link
        where reference_id = any(%s)
        order by distributor_reference_link_id
        """,
        (reference_ids,),
    )
    link_groups = defaultdict(list)
    for link_id, reference_id, distributor_id, variant, url in cur.fetchall():
        link_groups[(distributor_id, variant)].append({
            "link_id": link_id,
            "reference_id": reference_id,
            "distributor_id": distributor_id,
            "variant": variant,
            "url": url,
        })
    collisions = [group for group in link_groups.values() if len(group) > 1]
    redundant_link_ids = []
    if collisions:
        urls_are_identical = all(len({row["url"] for row in group}) == 1 for group in collisions)
        if not dedupe_identical_links or not urls_are_identical:
            return {
                "merged": False,
                "reason": "distributor_variant_collision",
                "collisions": collisions,
                "dependencies": dependency_details,
            }
        for group in collisions:
            survivor_rows = [row for row in group if row["reference_id"] == survivor_id]
            keeper = min(survivor_rows or group, key=lambda row: row["link_id"])
            redundant_link_ids.extend(
                row["link_id"] for row in group if row["link_id"] != keeper["link_id"]
            )

    if redundant_link_ids:
        redundant_link_ids = sorted(set(redundant_link_ids))
        cur.execute(
            """
            delete from public.distributor_reference_link
            where distributor_reference_link_id = any(%s)
            returning distributor_reference_link_id
            """,
            (redundant_link_ids,),
        )
        deleted_link_ids = sorted(row[0] for row in cur.fetchall())
        if deleted_link_ids != redundant_link_ids:
            raise RuntimeError(
                "Limpieza inconsistente durante merge: "
                f"esperados={redundant_link_ids}, borrados={deleted_link_ids}"
            )

    cur.execute(
        """
        update public.distributor_reference_link
        set reference_id = %s
        where reference_id = any(%s)
        """,
        (survivor_id, merged_ids),
    )
    moved_links = cur.rowcount
    cur.execute(
        "delete from public.reference where reference_id = any(%s) returning reference_id",
        (merged_ids,),
    )
    deleted_ids = sorted(row[0] for row in cur.fetchall())
    if deleted_ids != merged_ids:
        raise RuntimeError(
            f"Merge inconsistente: se esperaban borrar {merged_ids}, se borraron {deleted_ids}."
        )
    return {
        "merged": True,
        "survivor_reference_id": survivor_id,
        "merged_reference_ids": merged_ids,
        "moved_links": moved_links,
        "duplicate_links_deleted": redundant_link_ids,
        "dependencies": dependency_details,
    }


def prepare_reference_uniques(reference_items, existing_rows, stats):
    sku_owners = {sku: row_id for row_id, sku, _ in existing_rows if sku}
    ean_owners = {ean: row_id for row_id, _, ean in existing_rows if ean}

    for item in reference_items:
        values = list(item["reference"])
        referencia_id = item.get("resolved_reference_id")
        values[REFERENCE_ID] = referencia_id

        ean = values[REFERENCE_EAN13]
        ean_owner = ean_owners.get(ean) if ean else None
        if ean_owner is not None and ean_owner != referencia_id:
            values[REFERENCE_EAN13] = None
            stats["existing_eans_set_null"] += 1
        elif ean:
            ean_owners[ean] = referencia_id or item["record"]["_source_key"]

        sku = values[REFERENCE_SKU]
        sku_owner = sku_owners.get(sku) if sku else None
        if sku_owner is not None and sku_owner != referencia_id:
            base = sku or item["record"]["_source_key"]
            for attempt in range(100):
                suffix = hashlib.sha256(
                    f"{item['record']['_source_key']}:{base}:{attempt}".encode("utf-8")
                ).hexdigest()[:12]
                candidate = f"{str(base)[:107]}-{suffix}"
                if candidate not in sku_owners:
                    values[REFERENCE_SKU] = candidate
                    sku = candidate
                    stats["existing_skus_renamed"] += 1
                    break
            else:
                raise RuntimeError(
                    f"No se pudo generar SKU unico para {item['record']['_source_key']}"
                )
        sku_owners[sku] = referencia_id or item["record"]["_source_key"]
        item["reference"] = tuple(values)


def execute_load(dsn, payload, batch_size):
    if psycopg is None:
        raise RuntimeError("Falta psycopg; instalalo para ejecutar una carga real.")
    started_at = time.monotonic()
    stats = {
        "references_upserted": 0,
        "links_upserted": 0,
        "new_reference_ids": 0,
        "existing_reference_ids_reused": 0,
        "legacy_url_links_resolved": 0,
        "split_reference_items_merged": 0,
        "references_merged": 0,
        "links_moved_by_merge": 0,
        "split_reference_items_skipped": 0,
        "ambiguous_url_variant_items_skipped": 0,
        "ambiguous_url_variant_items_repaired": 0,
        "ambiguous_single_side_items_detached": 0,
        "duplicate_existing_links_deleted": 0,
        "existing_skus_renamed": 0,
        "existing_eans_set_null": 0,
        "duplicate_reference_payloads_ignored": 0,
        "duplicate_link_payloads_ignored": 0,
        "ambiguous_input_link_groups": 0,
        "ambiguous_input_links_omitted": 0,
        "items_without_unambiguous_links_skipped": 0,
    }
    split_reference_conflicts = []
    split_reference_merges = []
    ambiguous_url_variant_conflicts = []
    ambiguous_url_variant_repairs = []
    duplicate_reference_payloads = []
    ambiguous_input_links = []

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            distributor_ids = resolve_distributor_ids(cur)
            print(f"[DB] Distribuidoras resueltas: {len(distributor_ids)}", flush=True)

            existing_link_index = load_existing_link_index(cur, distributor_ids)
            print(
                f"[DB] Links existentes precargados: {sum(len(rows) for rows in existing_link_index.values())}",
                flush=True,
            )

            resolved_input_items = []
            for source_item in payload["load_items"]:
                resolved_input_items.append({
                    **source_item,
                    "links": [
                        link_with_distributor(link, distributor_ids)
                        for link in source_item["links"]
                    ],
                })

            input_link_owners = defaultdict(list)
            for item in resolved_input_items:
                for link in item["links"]:
                    key = (link[LINK_DISTRIBUIDORA_ID], link[LINK_URL], link[LINK_VARIANTE])
                    input_link_owners[key].append(item["record"]["_source_key"])
            ambiguous_input_keys = {
                key for key, source_keys in input_link_owners.items()
                if len(source_keys) > 1
            }
            stats["ambiguous_input_link_groups"] = len(ambiguous_input_keys)
            stats["ambiguous_input_links_omitted"] = sum(
                len(input_link_owners[key]) for key in ambiguous_input_keys
            )
            for key in sorted(ambiguous_input_keys, key=lambda value: (value[0], value[1] or "", value[2] or "")):
                source_keys = input_link_owners[key]
                print(
                    "WARNING: omitting ambiguous input link shared by "
                    f"{len(source_keys)} records: {key[1]} [{key[2]}]",
                    file=sys.stderr,
                )
                if len(ambiguous_input_links) < 100:
                    ambiguous_input_links.append({
                        "distribuidora_id": key[0],
                        "url": key[1],
                        "variante": key[2],
                        "source_keys": source_keys,
                    })

            accepted_items = []
            for item in resolved_input_items:
                item["links"] = [
                    link for link in item["links"]
                    if (link[LINK_DISTRIBUIDORA_ID], link[LINK_URL], link[LINK_VARIANTE])
                    not in ambiguous_input_keys
                ]
                if not item["links"]:
                    stats["items_without_unambiguous_links_skipped"] += 1
                    continue
                existing_links = []
                ambiguous_links = []
                for link in item["links"]:
                    matches = existing_link_index.get(
                        (link[LINK_DISTRIBUIDORA_ID], link[LINK_URL], link[LINK_VARIANTE]),
                        [],
                    )
                    if len(matches) > 1:
                        ambiguous_links.append({
                            "input": {
                                "distribuidora_id": link[LINK_DISTRIBUIDORA_ID],
                                "url": link[LINK_URL],
                                "variante": link[LINK_VARIANTE],
                            },
                            "existing_links": matches,
                        })
                    elif matches:
                        existing_links.append(matches[0])

                if ambiguous_links:
                    anchor_reference_ids = {
                        row["referencia_id"]
                        for row in existing_links
                        if row["referencia_id"] is not None
                    }
                    repaired_links = []
                    redundant_link_ids = []
                    if len(anchor_reference_ids) == 1:
                        anchor_reference_id = next(iter(anchor_reference_ids))
                        for conflict in ambiguous_links:
                            anchored = [
                                row for row in conflict["existing_links"]
                                if row["referencia_id"] == anchor_reference_id
                            ]
                            if len(anchored) != 1:
                                repaired_links = []
                                redundant_link_ids = []
                                break
                            repaired_links.append(anchored[0])
                            redundant_link_ids.extend(
                                row["id"]
                                for row in conflict["existing_links"]
                                if row["id"] != anchored[0]["id"]
                            )

                    duplicate_merge = None
                    duplicate_reference_ids = set()
                    if not repaired_links:
                        duplicate_reference_ids = {
                            row["referencia_id"]
                            for conflict in ambiguous_links
                            for row in conflict["existing_links"]
                            if row["referencia_id"] is not None
                        }
                        if duplicate_reference_ids:
                            duplicate_merge = safely_merge_split_references(
                                cur,
                                duplicate_reference_ids,
                                dedupe_identical_links=True,
                            )

                    if repaired_links and redundant_link_ids:
                        redundant_link_ids = sorted(set(redundant_link_ids))
                        cur.execute(
                            """
                            delete from public.distributor_reference_link
                            where distributor_reference_link_id = any(%s)
                            returning distributor_reference_link_id
                            """,
                            (redundant_link_ids,),
                        )
                        deleted_link_ids = {row[0] for row in cur.fetchall()}
                        if deleted_link_ids != set(redundant_link_ids):
                            raise RuntimeError(
                                "Limpieza inconsistente de links duplicados: "
                                f"esperados={redundant_link_ids}, borrados={sorted(deleted_link_ids)}"
                            )
                        for key, rows in list(existing_link_index.items()):
                            existing_link_index[key] = [
                                row for row in rows if row["id"] not in deleted_link_ids
                            ]
                        existing_links.extend(repaired_links)
                        stats["ambiguous_url_variant_items_repaired"] += 1
                        stats["duplicate_existing_links_deleted"] += len(deleted_link_ids)
                        if len(ambiguous_url_variant_repairs) < 100:
                            ambiguous_url_variant_repairs.append({
                                "source_kind": item["record"].get("_source_kind"),
                                "source_id": item["record"].get("id"),
                                "anchor_reference_id": next(iter(anchor_reference_ids)),
                                "deleted_link_ids": sorted(deleted_link_ids),
                                "repaired_links": repaired_links,
                            })
                        print(
                            "[DB] URL+variante duplicado reparado mediante referencia ancla: "
                            f"{next(iter(anchor_reference_ids))}; "
                            f"links eliminados {sorted(deleted_link_ids)}",
                            flush=True,
                        )
                    elif duplicate_merge and duplicate_merge["merged"]:
                        survivor_id = duplicate_merge["survivor_reference_id"]
                        merged_ids = set(duplicate_merge["merged_reference_ids"])
                        deleted_link_ids = set(duplicate_merge["duplicate_links_deleted"])
                        for key, rows in list(existing_link_index.items()):
                            retained = []
                            for row in rows:
                                if row["id"] in deleted_link_ids:
                                    continue
                                if row["referencia_id"] in merged_ids:
                                    row["referencia_id"] = survivor_id
                                retained.append(row)
                            existing_link_index[key] = retained
                        for conflict in ambiguous_links:
                            key = (
                                conflict["input"]["distribuidora_id"],
                                conflict["input"]["url"],
                                conflict["input"]["variante"],
                            )
                            repaired = existing_link_index.get(key, [])
                            if len(repaired) != 1:
                                raise RuntimeError(
                                    "La consolidacion de URL+variante no produjo un unico link: "
                                    f"{conflict['input']} -> {len(repaired)}"
                                )
                            existing_links.append(repaired[0])
                        stats["ambiguous_url_variant_items_repaired"] += 1
                        stats["duplicate_existing_links_deleted"] += len(deleted_link_ids)
                        stats["references_merged"] += len(merged_ids)
                        stats["links_moved_by_merge"] += duplicate_merge["moved_links"]
                        if len(ambiguous_url_variant_repairs) < 100:
                            ambiguous_url_variant_repairs.append({
                                "source_kind": item["record"].get("_source_kind"),
                                "source_id": item["record"].get("id"),
                                "repair": "identical_link_reference_merge",
                                **duplicate_merge,
                            })
                        print(
                            "[DB] Referencias duplicadas consolidadas por URL+variante identico: "
                            f"{sorted(merged_ids)} -> {survivor_id}; "
                            f"links eliminados {sorted(deleted_link_ids)}",
                            flush=True,
                        )
                    elif (
                        duplicate_merge
                        and not duplicate_merge["merged"]
                        and item["record"].get("_source_kind")
                        in {"only_eciglogistica", "only_vaperalia"}
                        and duplicate_reference_ids
                    ):
                        dependency_counts, dependency_details = reference_dependency_counts(
                            cur,
                            duplicate_reference_ids,
                        )
                        if any(dependency_counts.values()):
                            duplicate_merge = {
                                **duplicate_merge,
                                "detach_blocker": "business_dependencies",
                                "dependencies": dependency_details,
                            }
                            stats["ambiguous_url_variant_items_skipped"] += 1
                            if len(ambiguous_url_variant_conflicts) < 100:
                                ambiguous_url_variant_conflicts.append({
                                    "source_kind": item["record"].get("_source_kind"),
                                    "source_id": item["record"].get("id"),
                                    "conflicts": ambiguous_links,
                                    "repair_blocker": duplicate_merge,
                                })
                            print(
                                "WARNING: keeping ambiguous URL+variant because referenced "
                                f"business rows block detachment: {item['record'].get('id')}",
                                file=sys.stderr,
                            )
                            continue
                        else:
                            detached_link_ids = sorted({
                                row["id"]
                                for conflict in ambiguous_links
                                for row in conflict["existing_links"]
                            })
                            cur.execute(
                                """
                                delete from public.distributor_reference_link
                                where distributor_reference_link_id = any(%s)
                                returning distributor_reference_link_id
                                """,
                                (detached_link_ids,),
                            )
                            deleted_link_ids = {row[0] for row in cur.fetchall()}
                            if deleted_link_ids != set(detached_link_ids):
                                raise RuntimeError(
                                    "Detach inconsistente de links ambiguos: "
                                    f"esperados={detached_link_ids}, borrados={sorted(deleted_link_ids)}"
                                )
                            for key, rows in list(existing_link_index.items()):
                                existing_link_index[key] = [
                                    row for row in rows if row["id"] not in deleted_link_ids
                                ]
                            stats["ambiguous_url_variant_items_repaired"] += 1
                            stats["ambiguous_single_side_items_detached"] += 1
                            stats["duplicate_existing_links_deleted"] += len(deleted_link_ids)
                            if len(ambiguous_url_variant_repairs) < 100:
                                ambiguous_url_variant_repairs.append({
                                    "source_kind": item["record"].get("_source_kind"),
                                    "source_id": item["record"].get("id"),
                                    "repair": "detached_to_new_single_side_reference",
                                    "old_reference_ids": sorted(duplicate_reference_ids),
                                    "deleted_link_ids": sorted(deleted_link_ids),
                                })
                            print(
                                "[DB] Link ambiguo separado para crear referencia independiente: "
                                f"refs antiguas {sorted(duplicate_reference_ids)}; "
                                f"links eliminados {sorted(deleted_link_ids)}",
                                flush=True,
                            )
                    else:
                        stats["ambiguous_url_variant_items_skipped"] += 1
                        for conflict in ambiguous_links:
                            existing_refs = sorted({
                                row["referencia_id"]
                                for row in conflict["existing_links"]
                                if row["referencia_id"] is not None
                            })
                            print(
                                "WARNING: skipping item with ambiguous existing URL+variant "
                                f"across referencias {existing_refs}: "
                                f"{conflict['input']['url']} [{conflict['input']['variante']}]",
                                file=sys.stderr,
                            )
                        if len(ambiguous_url_variant_conflicts) < 100:
                            ambiguous_url_variant_conflicts.append({
                                "source_kind": item["record"].get("_source_kind"),
                                "source_id": item["record"].get("id"),
                                "conflicts": ambiguous_links,
                            })
                        continue

                existing_reference_ids = {row["referencia_id"] for row in existing_links if row["referencia_id"] is not None}
                if len(existing_reference_ids) > 1:
                    merge = safely_merge_split_references(cur, existing_reference_ids)
                    if merge["merged"]:
                        survivor_id = merge["survivor_reference_id"]
                        merged_ids = set(merge["merged_reference_ids"])
                        for rows in existing_link_index.values():
                            for row in rows:
                                if row["referencia_id"] in merged_ids:
                                    row["referencia_id"] = survivor_id
                        for row in existing_links:
                            if row["referencia_id"] in merged_ids:
                                row["referencia_id"] = survivor_id
                        stats["split_reference_items_merged"] += 1
                        stats["references_merged"] += len(merged_ids)
                        stats["links_moved_by_merge"] += merge["moved_links"]
                        existing_reference_ids = {survivor_id}
                        print(
                            "[DB] Merge seguro de referencias divididas: "
                            f"{sorted(merged_ids)} -> {survivor_id}",
                            flush=True,
                        )
                        if len(split_reference_merges) < 100:
                            split_reference_merges.append({
                                "source_kind": item["record"].get("_source_kind"),
                                "source_id": item["record"].get("id"),
                                **merge,
                            })
                    else:
                        stats["split_reference_items_skipped"] += 1
                        refs = ", ".join(str(value) for value in sorted(existing_reference_ids))
                        urls = ", ".join(link[LINK_URL] or "" for link in item["links"])
                        print(
                            "WARNING: skipping matched item already split across referencias "
                            f"({refs}; {merge['reason']}): {urls}",
                            file=sys.stderr,
                        )
                        if len(split_reference_conflicts) < 100:
                            split_reference_conflicts.append({
                                "source_kind": item["record"].get("_source_kind"),
                                "source_id": item["record"].get("id"),
                                "existing_reference_ids": sorted(existing_reference_ids),
                                "merge_blocker": merge,
                                "links": [
                                    {
                                        "distribuidora_id": row["distribuidora_id"],
                                        "url": row["url"],
                                        "variante": row["variante"],
                                        "referencia_id": row["referencia_id"],
                                    }
                                    for row in existing_links
                                ],
                            })
                        continue

                if existing_reference_ids:
                    referencia_id = next(iter(existing_reference_ids))
                    stats["existing_reference_ids_reused"] += 1
                    stats["legacy_url_links_resolved"] += len(existing_links)
                else:
                    referencia_id = None
                    stats["new_reference_ids"] += 1
                item["resolved_reference_id"] = referencia_id
                accepted_items.append(item)

            print(
                f"[DB] Resolucion: {len(accepted_items)} aceptados, "
                f"{stats['ambiguous_url_variant_items_skipped']} ambiguos, "
                f"{stats['split_reference_items_skipped']} divididos, "
                f"{stats['ambiguous_input_links_omitted']} links de entrada omitidos",
                flush=True,
            )

            reference_items = []
            reference_item_by_existing_id = {}
            for item in accepted_items:
                referencia_id = item["resolved_reference_id"]
                if referencia_id is None:
                    reference_items.append(item)
                    continue
                prior = reference_item_by_existing_id.get(referencia_id)
                if prior is None:
                    reference_item_by_existing_id[referencia_id] = item
                    reference_items.append(item)
                else:
                    stats["duplicate_reference_payloads_ignored"] += 1
                    if len(duplicate_reference_payloads) < 100:
                        duplicate_reference_payloads.append({
                            "referencia_id": referencia_id,
                            "kept_source_key": prior["record"]["_source_key"],
                            "ignored_source_key": item["record"]["_source_key"],
                        })

            cur.execute("select reference_id, sku, ean13 from public.reference")
            existing_reference_rows = cur.fetchall()
            prepare_reference_uniques(reference_items, existing_reference_rows, stats)

            existing_reference_prefix = """
                insert into public.reference (
                  reference_id, base_key, base_ratio, bottle_ml, caffeine, quantity_ml, category, color,
                  content_ml, ean13, product_line, brand, commercial_brand,
                  minimum_purchase_units, nicotine_level, name, resistance, pod_type,
                  product_type, flavor, size, sku
                ) values
            """
            reference_update_suffix = """
                on conflict (reference_id) do update set
                  base_key = excluded.base_key,
                  base_ratio = excluded.base_ratio,
                  bottle_ml = excluded.bottle_ml,
                  caffeine = excluded.caffeine,
                  quantity_ml = excluded.quantity_ml,
                  category = excluded.category,
                  color = excluded.color,
                  content_ml = excluded.content_ml,
                  ean13 = excluded.ean13,
                  product_line = excluded.product_line,
                  brand = excluded.brand,
                  commercial_brand = excluded.commercial_brand,
                  minimum_purchase_units = excluded.minimum_purchase_units,
                  nicotine_level = excluded.nicotine_level,
                  name = excluded.name,
                  resistance = excluded.resistance,
                  pod_type = excluded.pod_type,
                  product_type = excluded.product_type,
                  flavor = excluded.flavor,
                  size = excluded.size,
                  sku = excluded.sku
                returning reference_id, sku
            """
            existing_items = [item for item in reference_items if item["resolved_reference_id"] is not None]
            processed = 0
            for batch in iter_batches(existing_items, batch_size, 22):
                execute_values(
                    cur,
                    existing_reference_prefix,
                    [item["reference"] for item in batch],
                    reference_update_suffix,
                    returning=True,
                )
                processed += len(batch)
                print(f"[DB] Referencias existentes: {processed}/{len(existing_items)}", flush=True)

            new_reference_prefix = """
                insert into public.reference (
                  base_key, base_ratio, bottle_ml, caffeine, quantity_ml, category, color,
                  content_ml, ean13, product_line, brand, commercial_brand,
                  minimum_purchase_units, nicotine_level, name, resistance, pod_type,
                  product_type, flavor, size, sku
                ) values
            """
            new_reference_suffix = " returning reference_id, sku"
            new_items = [item for item in reference_items if item["resolved_reference_id"] is None]
            new_by_sku = {item["reference"][REFERENCE_SKU]: item for item in new_items}
            processed = 0
            for batch in iter_batches(new_items, batch_size, 21):
                returned = execute_values(
                    cur,
                    new_reference_prefix,
                    [item["reference"][1:] for item in batch],
                    new_reference_suffix,
                    returning=True,
                )
                for referencia_id, sku in returned:
                    new_by_sku[sku]["resolved_reference_id"] = referencia_id
                processed += len(batch)
                print(f"[DB] Referencias nuevas: {processed}/{len(new_items)}", flush=True)

            stats["references_upserted"] = len(reference_items)

            link_prefix = """
                insert into public.distributor_reference_link (
                  active, base_url, brand_candidates, breadcrumb_path, deleted_at,
                  derived_reference_color, description, match_confidence, match_reason,
                  meta_description, price_tax_excluded, reference_color, scraped_at,
                  source_brand, source_reference, source_title, synthetic_reference,
                  updated_at, url, variant_signature, variant, variants_json,
                  distributor_id, reference_id
                ) values
            """
            link_suffix = """
                on conflict (reference_id, distributor_id, variant) do update set
                  active = excluded.active,
                  base_url = excluded.base_url,
                  brand_candidates = excluded.brand_candidates,
                  breadcrumb_path = excluded.breadcrumb_path,
                  deleted_at = excluded.deleted_at,
                  derived_reference_color = excluded.derived_reference_color,
                  description = excluded.description,
                  match_confidence = excluded.match_confidence,
                  match_reason = excluded.match_reason,
                  meta_description = excluded.meta_description,
                  price_tax_excluded = excluded.price_tax_excluded,
                  reference_color = excluded.reference_color,
                  scraped_at = excluded.scraped_at,
                  source_brand = excluded.source_brand,
                  source_reference = excluded.source_reference,
                  source_title = excluded.source_title,
                  synthetic_reference = excluded.synthetic_reference,
                  updated_at = excluded.updated_at,
                  url = excluded.url,
                  variant_signature = excluded.variant_signature,
                  variants_json = excluded.variants_json
                returning distributor_reference_link_id
            """
            link_rows_by_key = {}
            for item in accepted_items:
                referencia_id = item["resolved_reference_id"]
                if referencia_id is None:
                    raise RuntimeError(
                        f"Referencia nueva sin ID para {item['record']['_source_key']}"
                    )
                for link in item["links"]:
                    row = link_with_reference(link, referencia_id)[1:]
                    key = (
                        row[LINK_REFERENCIA_ID - 1],
                        row[LINK_DISTRIBUIDORA_ID - 1],
                        row[LINK_VARIANTE - 1],
                    )
                    if key in link_rows_by_key:
                        stats["duplicate_link_payloads_ignored"] += 1
                    else:
                        link_rows_by_key[key] = row
            link_rows = list(link_rows_by_key.values())

            processed = 0
            for batch in iter_batches(link_rows, batch_size, 24):
                execute_values(cur, link_prefix, batch, link_suffix, returning=True)
                processed += len(batch)
                print(f"[DB] Links: {processed}/{len(link_rows)}", flush=True)
            stats["links_upserted"] = len(link_rows)

            cur.execute("select count(*) from public.reference")
            referencias_count = cur.fetchone()[0]
            cur.execute("select count(*) from public.distributor_reference_link")
            links_count = cur.fetchone()[0]
            cur.execute("select count(*) from public.distributor")
            distribuidoras_count = cur.fetchone()[0]
        conn.commit()
    elapsed_seconds = round(time.monotonic() - started_at, 3)
    print(f"[DB] COMMIT completado en {elapsed_seconds}s", flush=True)
    return {
        "referencias_count": referencias_count,
        "links_count": links_count,
        "distribuidoras_count": distribuidoras_count,
        "split_reference_conflict_sample": split_reference_conflicts,
        "split_reference_merge_sample": split_reference_merges,
        "ambiguous_url_variant_conflict_sample": ambiguous_url_variant_conflicts,
        "ambiguous_url_variant_repair_sample": ambiguous_url_variant_repairs,
        "duplicate_reference_payload_sample": duplicate_reference_payloads,
        "ambiguous_input_link_sample": ambiguous_input_links,
        "elapsed_seconds": elapsed_seconds,
        **stats,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--skip-ean-enrichment", action="store_true")
    parser.add_argument("--batch-size", type=int, default=1000)
    args = parser.parse_args()

    RUN_DIR.mkdir(parents=True, exist_ok=True)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    enrichment = {"ran": False, "reason": "skipped"}
    if not args.skip_ean_enrichment:
        enrichment = run_ean_enrichment()
        if enrichment.get("ran") and enrichment.get("returncode") != 0:
            raise SystemExit(f"Fallo enriquecimiento EAN13: {enrichment.get('stderr') or enrichment.get('stdout')}")

    payload = build_payload()
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dryRun": args.dry_run,
        "inputDir": str(INPUT_DIR),
        "eanEnrichment": enrichment,
        "planned": {
            "referencias": len(payload["referencias"]),
            "referencia_distribuidora_links": len(payload["links"]),
            "distribuidoras": len(DISTRIBUIDORAS),
        },
        "skuChanges": len(payload["sku_changes"]),
        "skuChangeSample": payload["sku_changes"][:100],
        "duplicateEansSetToNull": len(payload["duplicate_eans"]),
        "duplicateEanSample": payload["duplicate_eans"][:100],
        "eanRowsSetToNullBecauseDuplicate": len(payload["ean_nulls"]),
        "unresolvedVaperaliaLinks": len(payload["unresolved_vaperalia"]),
        "unresolvedVaperaliaSample": payload["unresolved_vaperalia"][:100],
    }

    if not args.dry_run:
        dsn = resolve_database_url()
        if not dsn:
            raise SystemExit("Falta DATABASE_URL o DATABASE_ENV_FILE en el entorno.")
        report["dbResult"] = execute_load(dsn, payload, args.batch_size)

    write_json(RUN_DIR / "sql-loader-report.json", report)
    lines = [
        "# SQLLoader report",
        "",
        f"Dry run: {args.dry_run}",
        "",
        "## Planned",
        "",
        f"- referencias: {report['planned']['referencias']}",
        f"- referencia_distribuidora_links: {report['planned']['referencia_distribuidora_links']}",
        f"- distribuidoras: {report['planned']['distribuidoras']}",
        "",
        "## Normalizaciones",
        "",
        f"- SKUs tecnicos generados por duplicidad/longitud: {report['skuChanges']}",
        f"- EAN duplicados dejados a NULL: {report['duplicateEansSetToNull']}",
        f"- Filas con EAN dejado a NULL por duplicidad: {report['eanRowsSetToNullBecauseDuplicate']}",
        f"- Links Vaperalia matched_both sin resolver en CSV preparado: {report['unresolvedVaperaliaLinks']}",
    ]
    if report.get("dbResult"):
        db_result = report["dbResult"]
        lines += [
            "",
            "## DB result",
            "",
            f"- referencias en tabla: {db_result['referencias_count']}",
            f"- referencia_distribuidora_links en tabla: {db_result['links_count']}",
            f"- distribuidoras en tabla: {db_result['distribuidoras_count']}",
            f"- referencias upsert ejecutadas: {db_result['references_upserted']}",
            f"- links upsert ejecutados: {db_result['links_upserted']}",
            f"- referencias nuevas generadas: {db_result['new_reference_ids']}",
            f"- referencias existentes reutilizadas desde links: {db_result['existing_reference_ids_reused']}",
            f"- links existentes resueltos por URL+variante: {db_result['legacy_url_links_resolved']}",
            f"- matched divididos fusionados de forma segura: {db_result['split_reference_items_merged']}",
            f"- referencias redundantes eliminadas por merge seguro: {db_result['references_merged']}",
            f"- links movidos por merge seguro: {db_result['links_moved_by_merge']}",
            f"- matched omitidos porque sus dos links ya apuntaban a referencias distintas: {db_result['split_reference_items_skipped']}",
            f"- items URL+variante duplicados reparados mediante ancla: {db_result['ambiguous_url_variant_items_repaired']}",
            f"- items de un solo proveedor separados a referencia nueva: {db_result['ambiguous_single_side_items_detached']}",
            f"- links existentes redundantes eliminados: {db_result['duplicate_existing_links_deleted']}",
            f"- items omitidos por URL+variante duplicado en links existentes: {db_result['ambiguous_url_variant_items_skipped']}",
            f"- SKUs renombrados por conflicto contra BDD existente: {db_result['existing_skus_renamed']}",
            f"- EAN13 dejados a NULL por conflicto contra BDD existente: {db_result['existing_eans_set_null']}",
        ]
    (RUN_DIR / "sql-loader-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
