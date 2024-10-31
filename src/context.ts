import { LRUCache } from "lru-cache";
import { CrateIndex, CrateSearch } from "./types";
import TTLCache from "@isaacs/ttlcache";
import { CratesIo } from "./services/crates.io";

export default class Context {
  indexCache: LRUCache<string, CrateIndex>;
  searchCache: TTLCache<string, CrateSearch>;
  cratesIo: CratesIo;

  constructor() {
    this.indexCache = new LRUCache({
      max: 100
    });
    this.searchCache = new TTLCache({
      ttl: 3 * 1000 * 60,
      max: 100,
    });
    this.cratesIo = new CratesIo();
  }
}