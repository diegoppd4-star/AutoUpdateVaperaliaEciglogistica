#!/usr/bin/env python
import argparse
import csv
import hashlib
import json
import os
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT_DIR = ROOT / "input_master"
PREPARED_DIR = INPUT_DIR / "prepared"
RUN_DIR = ROOT / "run_output"
LOG_DIR = ROOT / "logs"
VENDOR_DIR = ROOT / "vendor"

sys.path.insert(0, str(VENDOR_DIR))
import psycopg  # noqa: E402

DISTRIBUIDORAS = {
    "eciglogistica": {
        "id": None,
        "nombre": "Eciglogistica",
        "tiempo_entrega_default_dias": 0,
    },
    "vaperalia": {
        "id": None,
        "nombre": "Vaperalia",
        "tiempo_entrega_default_dias": 0,
    },
}

for key, data in DISTRIBUIDORAS.items():
    data["id"] = int(hashlib.sha256(f"distribuidora:{key}".encode("utf-8")).hexdigest()[:15], 16)


def stable_id(value: str) -> int:
    return int(hashlib.sha256(value.encode("utf-8")).hexdigest()[:15], 16)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8-sig"))


def write_json(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")


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
        record["_referencia_id"],
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


def link_tuple(record, side, distribuidora_id, row, resolution):
    url = row.get("url") or (record.get("eciglogistica_url") if side == "eciglogistica" else record.get("vaperalia_url")) or ""
    variant = link_variant(row, record)
    return (
        stable_id(f"link:{side}:{record['_source_key']}:{url}:{variant}"),
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
        distribuidora_id,
        record["_referencia_id"],
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
            record["_referencia_id"] = stable_id(f"referencia:{record['_source_key']}")
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
    unresolved_vaperalia = []
    for record in records:
        if record["_source_kind"] in ("matched_both", "only_eciglogistica"):
            row, resolution = row_for_link(record, "eciglogistica")
            links.append(link_tuple(record, "eciglogistica", DISTRIBUIDORAS["eciglogistica"]["id"], row, resolution))
        if record["_source_kind"] in ("matched_both", "only_vaperalia"):
            row, resolution = row_for_link(record, "vaperalia", vaperalia_index)
            if record["_source_kind"] == "matched_both" and resolution == "unresolved":
                unresolved_vaperalia.append({"id": record.get("id"), "url": record.get("vaperalia_url")})
            links.append(link_tuple(record, "vaperalia", DISTRIBUIDORAS["vaperalia"]["id"], row, resolution))

    return {
        "records": records,
        "referencias": referencias,
        "links": links,
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


def execute_load(dsn, payload, batch_size):
    distribuidoras = [
        (data["id"], data["nombre"], data["tiempo_entrega_default_dias"])
        for data in DISTRIBUIDORAS.values()
    ]

    with psycopg.connect(dsn) as conn:
        with conn.cursor() as cur:
            cur.executemany(
                """
                insert into public.distribuidoras (id, nombre, tiempo_entrega_default_dias)
                values (%s, %s, %s)
                on conflict (id) do update set
                  nombre = excluded.nombre,
                  tiempo_entrega_default_dias = excluded.tiempo_entrega_default_dias
                """,
                distribuidoras,
            )

            ref_sql = """
                insert into public.referencias (
                  id, base_key, base_ratio, bote_ml, cafeina, cantidad_ml, categoria, color,
                  contenido_ml, ean13, linea_producto, marca, marca_comercial,
                  minimo_unidades_compra, nivel_nicotina, name, omniaje, pod_type,
                  product_type, sabor, tamano, sku
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (id) do update set
                  base_key = excluded.base_key,
                  base_ratio = excluded.base_ratio,
                  bote_ml = excluded.bote_ml,
                  cafeina = excluded.cafeina,
                  cantidad_ml = excluded.cantidad_ml,
                  categoria = excluded.categoria,
                  color = excluded.color,
                  contenido_ml = excluded.contenido_ml,
                  ean13 = excluded.ean13,
                  linea_producto = excluded.linea_producto,
                  marca = excluded.marca,
                  marca_comercial = excluded.marca_comercial,
                  minimo_unidades_compra = excluded.minimo_unidades_compra,
                  nivel_nicotina = excluded.nivel_nicotina,
                  name = excluded.name,
                  omniaje = excluded.omniaje,
                  pod_type = excluded.pod_type,
                  product_type = excluded.product_type,
                  sabor = excluded.sabor,
                  tamano = excluded.tamano,
                  sku = excluded.sku
            """
            cur.executemany(ref_sql, payload["referencias"])

            link_sql = """
                insert into public.referencia_distribuidora_links (
                  id, activo, base_url, brand_candidates, breadcrumb_path, deleted_at,
                  derived_reference_color, description, match_confidence, match_reason,
                  meta_description, price_tax_excluded, reference_color, scraped_at,
                  source_brand, source_reference, source_title, synthetic_reference,
                  updated_at, url, variant_signature, variante, variants_json,
                  distribuidora_id, referencia_id
                )
                values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                on conflict (id) do update set
                  activo = excluded.activo,
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
                  variante = excluded.variante,
                  variants_json = excluded.variants_json,
                  distribuidora_id = excluded.distribuidora_id,
                  referencia_id = excluded.referencia_id
            """
            cur.executemany(link_sql, payload["links"])

            cur.execute("select count(*) from public.referencias")
            referencias_count = cur.fetchone()[0]
            cur.execute("select count(*) from public.referencia_distribuidora_links")
            links_count = cur.fetchone()[0]
            cur.execute("select count(*) from public.distribuidoras")
            distribuidoras_count = cur.fetchone()[0]
        conn.commit()
    return {
        "referencias_count": referencias_count,
        "links_count": links_count,
        "distribuidoras_count": distribuidoras_count,
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
        dsn = os.environ.get("DATABASE_URL")
        if not dsn:
            raise SystemExit("Falta DATABASE_URL en el entorno.")
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
        lines += [
            "",
            "## DB result",
            "",
            f"- referencias en tabla: {report['dbResult']['referencias_count']}",
            f"- referencia_distribuidora_links en tabla: {report['dbResult']['links_count']}",
            f"- distribuidoras en tabla: {report['dbResult']['distribuidoras_count']}",
        ]
    (RUN_DIR / "sql-loader-report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2, default=str))


if __name__ == "__main__":
    main()
