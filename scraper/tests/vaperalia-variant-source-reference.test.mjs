import assert from "node:assert/strict";
import test from "node:test";

import { load } from "cheerio";
import { VaperaliaConnector } from "../dist/connectors/vaperalia.js";
import { expandVariants } from "../dist/crawler.js";

const PRODUCT_URL = "https://vaperalia.es/kings-crest-salts/tabaco-dulce-10ml-kings-crest-salts-9052.html";

function productHtml() {
  return `
    <html>
      <body>
        <h1>Tabaco Dulce 10ml - Kings Crest Salts</h1>
        <script>
          var productEan13 = '2000001196786';
          var productReference = 'KC-TABACO.DULCE.SALTS-10ml';
          var attributesCombinations = [
            {"id_attribute":"383","attribute":"10_mg","group":"nicotina"},
            {"id_attribute":"85","attribute":"20_mg","group":"nicotina"},
            {"id_attribute":"43","attribute":"10_ml","group":"capacidad_bote"}
          ];
        </script>
        <fieldset class="attribute_fieldset">
          <label class="attribute_label">Nicotina:</label>
          <div class="attribute_list"><ul>
            <li><input type="radio" value="383"><span>10 mg</span></li>
            <li><input type="radio" value="85"><span>20 mg</span></li>
          </ul></div>
        </fieldset>
        <fieldset class="attribute_fieldset">
          <label class="attribute_label">Capacidad:</label>
          <div class="attribute_list"><ul>
            <li><input type="radio" value="43"><span>10 ml</span></li>
          </ul></div>
        </fieldset>
      </body>
    </html>
  `;
}

function combinationsPayload({ includeEan = true } = {}) {
  return [
    {
      attributes_values: { "8": "10 ml", "7": "10 mg" },
      reference: "KC-TABACO.DULCE.SALTS-10ml-10mg",
      ...(includeEan ? { ean13: "2000001256992" } : {})
    },
    {
      attributes_values: { "7": "20 mg", "8": "10 ml" },
      reference: "KC-TABACO.DULCE.SALTS-10ml-20mg",
      ...(includeEan ? { ean13: "2000001257005" } : {})
    }
  ];
}

async function enrichWithPayload(t, payload) {
  const previousFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = previousFetch; });
  globalThis.fetch = async () => new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
  return new VaperaliaConnector().enrichProductFromHtml(load(productHtml()), PRODUCT_URL);
}

function expand(enrichment) {
  return expandVariants(
    {
      distributor: "Vaperalia",
      name: enrichment.fullName,
      url: PRODUCT_URL,
      reference: enrichment.reference
    },
    enrichment.variants,
    enrichment.variantUrlSegments,
    enrichment.variantReferenceValues,
    enrichment.variantSourceReferences
  );
}

test("Vaperalia assigns the combination EAN instead of the parent productEan13", async (t) => {
  const enrichment = await enrichWithPayload(t, combinationsPayload());

  assert.equal(enrichment.reference, "2000001196786");
  assert.deepEqual(enrichment.variantSourceReferences, [
    { attributeValues: ["10 mg", "10 ml"], sourceReference: "2000001256992" },
    { attributeValues: ["20 mg", "10 ml"], sourceReference: "2000001257005" }
  ]);

  const products = expand(enrichment);
  assert.equal(products.length, 2);
  assert.equal(products.find((product) => product.variants?.Nicotina === "10 mg")?.reference, "2000001256992");
  assert.equal(products.find((product) => product.variants?.Nicotina === "20 mg")?.reference, "2000001257005");
});

test("Vaperalia does not copy the parent identifier when combination EANs are unavailable", async (t) => {
  const enrichment = await enrichWithPayload(t, combinationsPayload({ includeEan: false }));

  assert.deepEqual(enrichment.variantSourceReferences, []);
  const products = expand(enrichment);
  assert.equal(products.length, 2);
  assert.ok(products.every((product) => product.reference === undefined));
});
