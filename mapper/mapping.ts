import type { Api, Mapping } from "./types";

export async function executeMapping(sourceApi: Api, targetApi: Api, mapping: Mapping) {
    fetch(`${sourceApi.baseUrl}${mapping.source.path}`)
}