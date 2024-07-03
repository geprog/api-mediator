export type Api = {
    name: string;
    baseUrl: string;
    accessToken: string;
    endpoints: Endpoint[];
    schemas: Schema[];
}

export type Endpoint = {
    name: string;
    description?: string;
    path: string;
    method: string;
    // parameters: Schema;
    responseSchema: Schema;
}

export type Schema = {
    name: string;
    description?: string;
    fields: Field[];
}

export type Field = {
    name: string;
    description?: string;
    type: string | Schema;
}

export type Mapping = {
    source: Endpoint;
    target: Endpoint;
    /**
     * {
     *      title: 'title',
     *      body: 'description',
     *      author: 'creator',
     * }
     */
    mapping: Record<string, string>;
}
