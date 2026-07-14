async function test() {
  const cardName = "Dark Ritual";
  
  // Try with exclamation mark
  const resExcl = await fetch(`https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22&unique=prints`, {
    headers: { 'User-Agent': 'Grimore/1.0 (grimore@lgs.com)' }
  });
  const jsonExcl = await resExcl.json();
  console.log(`Exclamation results: Found ${(jsonExcl.data || []).length} prints`);
  
  // Try with name:
  const resName = await fetch(`https://api.scryfall.com/cards/search?q=name:%22${encodeURIComponent(cardName)}%22+is:paper+not:funny&unique=prints`, {
    headers: { 'User-Agent': 'Grimore/1.0 (grimore@lgs.com)' }
  });
  const jsonName = await resName.json();
  console.log(`Name results: Found ${(jsonName.data || []).length} prints`);
  
  // Try with exact name: (using ++"Card Name" or oracle name query)
  // Let's print the first print of Name results to verify they are all Dark Ritual
  if (jsonName.data && jsonName.data.length > 0) {
    const matchingCount = jsonName.data.filter(c => c.name === cardName).length;
    console.log(`Name results matching exactly "${cardName}": ${matchingCount} of ${jsonName.data.length}`);
  }
}

test();
