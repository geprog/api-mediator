import OpenAPIParser from "@readme/openapi-parser";
import type { Api } from "./types";

export async function parseOpenAPISpec(apiSpecPath: string, baseUrl: string): Api {
    try {
        const apiSpecContent = await Bun.file(apiSpecPath).text();
        let apiSpec = await OpenAPIParser.validate(apiSpecContent);
        console.log('Parsed openapi spec of API name: %s, Version: %s', apiSpec.info.title, apiSpec.info.version);

        const specs = apiSpec.paths || {};
        const api: Api = {
            name: apiSpec.info.title,
            baseUrl,
            accessToken: '',
            endpoints: Object.keys(specs).map((path) => {
                const spec = specs[path];
            }),
            schemas: [],
        };
        return api;
      } catch (err) {
        console.error(err);
      }
}