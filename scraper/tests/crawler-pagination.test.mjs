import assert from "node:assert/strict";
import test from "node:test";

import { crawl } from "../dist/crawler.js";

function browserContext(statusForUrl) {
  const page = {
    async goto(url) {
      const status = statusForUrl(url);
      return { status: () => status, headers: () => ({}) };
    },
    async close() {},
  };
  return { async newPage() { return page; } };
}

function connector(seedUrl, nextPageUrl) {
  return {
    name: "Eciglogistica",
    baseUrl: "https://example.test",
    failOnListingFailures: true,
    linkedPaginationNotFoundEndsCategory: true,
    async getCategorySeeds() {
      return [{ id: "coils", name: "Coils", url: seedUrl }];
    },
    async listProductsFromCategory() {
      return { products: [], nextPageUrl, cardExtractionErrors: [] };
    },
    enrichProductFromHtml() {
      return { variants: {} };
    },
  };
}

const options = {
  limit: 0,
  debug: false,
  debugDir: "",
  concurrency: 1,
};

test("linked pagination 404 ends an Eciglogistica category", async () => {
  const seedUrl = "https://example.test/coils";
  const nextPageUrl = "https://example.test/coils/pagina/2";
  const result = await crawl(
    connector(seedUrl, nextPageUrl),
    browserContext((url) => url === nextPageUrl ? 404 : 200),
    options
  );

  assert.equal(result.totalPages, 1);
  assert.deepEqual(result.listingFailures, []);
});

test("seed-page 404 remains a critical listing failure", async () => {
  const seedUrl = "https://example.test/coils";
  await assert.rejects(
    crawl(
      connector(seedUrl, null),
      browserContext(() => 404),
      options
    ),
    /Critical listing failures: 1/
  );
});
