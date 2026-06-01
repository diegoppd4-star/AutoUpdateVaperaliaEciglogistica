function normalize(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function compact(value) {
  return normalize(value).replace(/[^a-z0-9]+/g, "");
}

function parseBrandList(value) {
  return String(value || "")
    .split(/[|,]/)
    .map((brand) => brand.trim())
    .filter(Boolean);
}

const BRAND_ALIAS_RULES = [
  {
    ecig: "Aromes et liquides",
    vaperalia: ["A&L", "A&L Hidden Potion", "A&L Les Creations"],
    productTypes: ["aroma_concentrate"],
  },
  {
    ecig: "Dinner Lady",
    vaperalia: ["Dinner Lady Salts"],
    productTypes: ["nicotine_salt"],
  },
  {
    ecig: "Dinner Lady",
    vaperalia: ["Dinner Lady Dessert Bar", "Dinner Lady Desserts", "Dinner Lady Fruitfull Bar"],
    productTypes: ["aroma_concentrate"],
  },
  {
    ecig: "Dinner Lady",
    vaperalia: ["Dinner Lady Fruitfull Bar"],
    productTypes: ["eliquid", "nicotine_salt"],
  },
  {
    ecig: "Vapeur France",
    vaperalia: ["Bubble Island", "Nova Liquides"],
    productTypes: ["aroma_concentrate"],
  },
  {
    ecig: "Drops",
    vaperalia: ["Five Drops"],
    productTypes: ["aroma_concentrate", "eliquid", "nicotine_salt"],
  },
  {
    ecig: "IVG E-Liquids",
    vaperalia: ["IVG Salt"],
    productTypes: ["nicotine_salt"],
  },
];

function productTypeMatches(rule, productType) {
  return !rule.productTypes || !productType || rule.productTypes.includes(productType);
}

function addUnique(map, value) {
  const key = compact(value);
  if (key && !map.has(key)) map.set(key, value);
}

function getTargetBrands(brand, productType, from = "ecig", to = "vaperalia") {
  const sourceBrands = parseBrandList(brand);
  const targets = new Map();
  for (const sourceBrand of sourceBrands) {
    addUnique(targets, sourceBrand);
    const sourceKey = compact(sourceBrand);
    for (const rule of BRAND_ALIAS_RULES) {
      if (!productTypeMatches(rule, productType)) continue;
      const ruleSources = Array.isArray(rule[from]) ? rule[from] : [rule[from]];
      if (!ruleSources.some((candidate) => compact(candidate) === sourceKey)) continue;
      const ruleTargets = Array.isArray(rule[to]) ? rule[to] : [rule[to]];
      for (const targetBrand of ruleTargets) addUnique(targets, targetBrand);
    }
  }
  return [...targets.values()];
}

module.exports = {
  BRAND_ALIAS_RULES,
  compact,
  getTargetBrands,
  parseBrandList,
};
