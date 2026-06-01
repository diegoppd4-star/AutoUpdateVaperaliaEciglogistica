const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { getTargetBrands } = require("./brand-aliases");

function parseArgs(argv) {
  const args = {
    aBase: "outputs/prepared/eciglogistica__output.base.csv",
    bBase: "outputs/prepared/vaperalia__output.base.csv",
    aVariants: "outputs/prepared/eciglogistica__output.variants.csv",
    bVariants: "outputs/prepared/vaperalia__output.variants.csv",
    outDir: "outputs",
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
  if (args.tramosFile) {
    args.tramos = fs.readFileSync(args.tramosFile, "utf8")
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter((item) => item && !item.startsWith("#"))
      .join(",");
  }
  if (!args.tramos) {
    throw new Error("Uso: node scripts/run-fuzzy-hardware-tramos.js --tramos voopoo:pod_replacement,uwell:coil [--tramos-file tramos.txt]");
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
    atomizer_tank: "atomizer",
    battery_charger: "battery-charger",
    kit_device: "kit",
    mod_device: "mod",
    nicotine_salt: "nicotine-salt",
    pod_replacement: "pod-replacement",
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
    const [brandPart, productType] = item.split(":");
    if (!brandPart || !productType) throw new Error(`Tramo invalido: ${item}`);
    const [aBrand, bBrand] = brandPart.split("=>").map((part) => part.trim());
    const bBrands = bBrand ? [bBrand] : getTargetBrands(aBrand, productType, "ecig", "vaperalia");
    return { brand: aBrand, aBrand, bBrand: bBrands.join("|"), productType };
  });

  fs.mkdirSync(args.outDir, { recursive: true });
  for (const tramo of tramos) {
    const id = `${slug(tramo.brand)}-${typeSlug(tramo.productType)}`;
    const baseOut = path.join(args.outDir, `base-matches-output.${id}.csv`);
    const variantOut = path.join(args.outDir, `variant-matches-output.${id}.csv`);
    const validOut = path.join(args.outDir, `${id}.matches.valid.json`);
    const readableOut = path.join(args.outDir, `${id}.matches.readable.json`);

    console.log(`\n=== ${id} ===`);
    run(process.execPath, [
      "scripts/fuzzy-hardware-base-matcher.js",
      "--a", args.aBase,
      "--b", args.bBase,
      "--out", baseOut,
      "--brand", tramo.brand,
      "--a-brand", tramo.aBrand,
      "--b-brand", tramo.bBrand,
      "--product-type", tramo.productType,
    ]);
    const variantArgs = [
      "scripts/variant-matcher.js",
      "--base-matches", baseOut,
      "--a-variants", args.aVariants,
      "--b-variants", args.bVariants,
      "--out", variantOut,
      "--accept-base-only",
    ];
    if (["aroma_concentrate", "eliquid", "nicotine_salt"].includes(tramo.productType)) {
      variantArgs.push("--partial-capacity-confidence", "0.9");
    }
    run(process.execPath, variantArgs);
    run(process.execPath, [
      "scripts/build-valid-matches-json.js",
      "--base-matches", baseOut,
      "--variant-matches", variantOut,
      "--b-variants", args.bVariants,
      "--a-base", args.aBase,
      "--b-base", args.bBase,
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
