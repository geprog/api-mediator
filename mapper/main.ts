import { generateMapping } from './generate_mapping';

async function main() {
  const mapping = await generateMapping();
  console.log(mapping);
}

main();