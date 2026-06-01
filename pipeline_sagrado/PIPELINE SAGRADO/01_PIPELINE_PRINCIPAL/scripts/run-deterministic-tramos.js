const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function parseArgs(argv) {
  const args = {
    aBase: "outputs/prepared/eciglogistica__output.base.csv",
    bBase: "outputs/prepared/vaperalia__output.base.csv",
    aVariants: "outputs/prepared/eciglogistica__output.variants.csv",
    bVariants: "outputs/prepared/vaperalia__output.variants.csv",
    tramos: "",
  };
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
  if (!args.tramos) {
    throw new Error("Uso: node scripts/run-deterministic-tramos.js --tramos voopoo:kit_device,oxva:kit_device");
  }
  return args;
}

function slug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function typeSlug(productType) {
  const map = {
    kit_device: "kit",
    mod_device: "mod",
    atomizer_tank: "atomizer",
    pod_replacement: "pod-replacement",
    battery_charger: "battery-charger",
    aroma_concentrate: "aroma-concentrate",
    nicotine_salt: "nicotine-salt",
  };
  return map[productType] || slug(productType);
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: false });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} fallo con codigo ${result.status}`);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const tramos = args.tramos.split(",").map((item) => item.trim()).filter(Boolean).map((item) => {
    const [brand, productType] = item.split(":");
    if (!brand || !productType) throw new Error(`Tramo invalido: ${item}`);
    return { brand, productType };
  });

  fs.mkdirSync("outputs", { recursive: true });
  for (const tramo of tramos) {
    const id = `${slug(tramo.brand)}-${typeSlug(tramo.productType)}`;
    const baseOut = path.join("outputs", `base-matches-output.${id}.csv`);
    const variantOut = path.join("outputs", `variant-matches-output.${id}.csv`);
    const validOut = path.join("outputs", `${id}.matches.valid.json`);
    const readableOut = path.join("outputs", `${id}.matches.readable.json`);

    console.log(`\n=== ${id} ===`);
    run(process.execPath, [
      "scripts/deterministic-base-matcher.js",
      "--a", args.aBase,
      "--b", args.bBase,
      "--out", baseOut,
      "--brand", tramo.brand,
      "--product-type", tramo.productType,
    ]);
    run(process.execPath, [
      "scripts/variant-matcher.js",
      "--base-matches", baseOut,
      "--a-variants", args.aVariants,
      "--b-variants", args.bVariants,
      "--out", variantOut,
      "--accept-base-only",
    ]);
    run(process.execPath, [
      "scripts/build-valid-matches-json.js",
      "--base-matches", baseOut,
      "--variant-matches", variantOut,
      "--b-variants", args.bVariants,
      "--out", validOut,
    ]);
    run(process.execPath, [
      "scripts/export-readable-json.js",
      "--base-matches", baseOut,
      "--variant-matches", variantOut,
      "--out", readableOut,
    ]);
  }
}

main();
