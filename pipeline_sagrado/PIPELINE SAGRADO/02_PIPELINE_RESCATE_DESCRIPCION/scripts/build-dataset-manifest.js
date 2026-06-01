const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = { inDir: "outputs", out: "outputs/datasets.json" };
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (value == null || value.startsWith("--")) {
      args[name] = true;
      continue;
    }
    args[name] = value;
    i += 1;
  }
  return args;
}

const TYPE_LABELS = {
  kit: "kits",
  "pod-replacement": "recambios pod",
  coil: "resistencias/coils",
  mod: "mods",
  atomizer: "atomizadores/tanks",
  glass: "pyrex/glass",
  "kit-device": "kits",
  "mod-device": "mods",
  "atomizer-tank": "atomizadores/tanks",
  "battery-charger": "baterias/cargadores",
  "aroma-concentrate": "aromas/concentrados",
  "nicotine-salt": "sales de nicotina",
  pyrex: "pyrex/glass",
  "orphan-rescues": "rescates huerfanos",
};

const TYPE_ORDER = {
  kit: 10,
  "kit-device": 10,
  "pod-replacement": 20,
  coil: 30,
  mod: 40,
  "mod-device": 40,
  atomizer: 50,
  "atomizer-tank": 50,
  glass: 60,
  pyrex: 60,
  "battery-charger": 70,
  "aroma-concentrate": 80,
  "nicotine-salt": 90,
  "orphan-rescues": 5,
};

const BRAND_ORDER = {
  global: 1,
  vaporesso: 10,
  voopoo: 20,
  oxva: 30,
  lostvape: 40,
  geekvape: 50,
  uwell: 60,
  smok: 70,
  aspire: 80,
  joyetech: 90,
};

function titleCaseBrand(value) {
  const known = {
    vaporesso: "Vaporesso",
    voopoo: "Voopoo",
    oxva: "Oxva",
    lostvape: "Lost Vape",
    geekvape: "Geekvape",
    uwell: "Uwell",
    smok: "Smok",
    aspire: "Aspire",
    joyetech: "Joyetech",
    hellvape: "Hellvape",
    eleaf: "Eleaf",
    efest: "Efest",
    innokin: "Innokin",
    "dinner-lady": "Dinner Lady",
    "full-moon": "Full Moon",
    "alquimia-para-vapers": "Alquimia Para Vapers",
    vapemoniadas: "Vapemoniadas",
    maori: "Maori",
    oil4vap: "Oil4Vap",
    global: "Global",
  };
  if (known[value]) return known[value];
  return value
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function datasetParts(id) {
  const knownTypes = Object.keys(TYPE_LABELS).sort((left, right) => right.length - left.length);
  const type = knownTypes.find((candidate) => id.endsWith(`-${candidate}`)) || "";
  const brand = type ? id.slice(0, -(type.length + 1)) : id;
  return { brand, type };
}

function labelFor(id) {
  if (id === "general") return "General";
  if (id === "reviewed-rescues") return "Emparejamientos IA no determinista";
  if (id === "description-rescue-candidates") return "Rescates por descripcion";
  if (id === "inverse-vaperalia-audit") return "Inversa Vaperalia no cubierta";
  if (id === "catalog-filtered-unmatched") return "Catalogo filtrado sin match";
  const { brand, type } = datasetParts(id);
  return `${titleCaseBrand(brand)} ${TYPE_LABELS[type] || type.replace(/-/g, " ")}`;
}

function orderFor(id) {
  if (id === "general") return 1;
  if (id === "reviewed-rescues") return 2;
  if (id === "description-rescue-candidates") return 3;
  if (id === "inverse-vaperalia-audit") return 80;
  if (id === "catalog-filtered-unmatched") return 90;
  const { brand, type } = datasetParts(id);
  return (BRAND_ORDER[brand] || 1000) * 100 + (TYPE_ORDER[type] || 90);
}

function main() {
  const args = parseArgs(process.argv);
  const files = fs.readdirSync(args.inDir)
    .filter((file) => file.endsWith(".matches.valid.json"))
    .sort();
  const datasets = files.map((file) => {
    const id = file.replace(/\.matches\.valid\.json$/, "");
    let summary = {};
    try {
      summary = JSON.parse(fs.readFileSync(path.join(args.inDir, file), "utf8")).summary || {};
    } catch {
      summary = {};
    }
    return {
      id,
      label: labelFor(id),
      url: `outputs/${file}`,
      order: orderFor(id),
      summary: {
        validVariants: summary.validVariants || 0,
        probableVariants: summary.probableVariants || 0,
        baseRows: summary.baseRows || 0,
        baseNoMatch: summary.discardedBaseMatches || summary.discarded?.baseNoMatch || 0,
      },
    };
  }).filter((dataset) =>
    dataset.summary.baseRows > 0 ||
    dataset.summary.validVariants > 0 ||
    dataset.summary.probableVariants > 0
  ).sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(datasets, null, 2)}\n`, "utf8");
  console.log(`Datasets: ${datasets.length}`);
  console.log(`Archivo: ${args.out}`);
}

main();
