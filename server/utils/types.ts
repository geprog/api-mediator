export type Api = {
  id: string;
  name: string;
  baseUrl: string;
  accessToken: string;
  parameterSubstitutions: {
    name: string;
    value: string;
  }[];
  endpoints: Endpoint[];
  schemas: Schema[];
};

export type Endpoint = {
  name: string;
  description?: string;
  path: string;
  method: string;
  parameters: Field[];
  requestBody: string;
  responseSchema: string;
};

export type Schema = {
  name: string;
  description?: string;
  fields: Field[];
};

export type Field = {
  name: string;
  description?: string;
  //   type: string | Schema;
};

export type MappingPart = {
  api: string;
  getAll?: Endpoint;
  getOne?: Endpoint;
  create?: Endpoint;
  update?: Endpoint;
  delete?: Endpoint;
  fieldMapping: Record<string, string>;
};

export type Mapping = {
  id: string;
  name: string;
  parts: MappingPart[];
};

export type EndpointMappings = {
  [category: string]: {
    api1: {
      getAll: string;
      getOne: string;
      create: string;
      update: string;
      delete: string;
    };
    api2: {
      getAll: string;
      getOne: string;
      create: string;
      update: string;
      delete: string;
    };
  };
};
