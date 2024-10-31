import { CrateIndex, CrateSearch } from "../types";

const API_URL = new URL("https://crates.io");
//const INDEX_URL = new URL("https://index.crates.io");
const HEADERS = { "User-Agent": "AlsoSylv/Crowbar" };

export class CratesIo {
  async getIndex(name: string): Promise<CrateIndex> {
    const url = API_URL;
    url.pathname = `/api/v1/crates/${name}/versions`;

    const res = await fetch(url, { headers: HEADERS });
    const json = await res.json();

    return json as CrateIndex;
  }

  async getSearch(name: string): Promise<CrateSearch> {
    const url = API_URL;
    url.pathname = "/api/v1/crates";
    url.searchParams.set("q", name);

    const res = await fetch(url, { headers: HEADERS });
    const json = await res.json();

    return json as CrateSearch;
  }
}