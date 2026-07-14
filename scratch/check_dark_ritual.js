async function test() {
  const cardName = "Dark Ritual";
  
  // Try 1: Exact search operator
  const url1 = `https://api.scryfall.com/cards/search?q=exact:%22${encodeURIComponent(cardName)}%22+is:paper+not:funny&unique=prints`;
  const res1 = await fetch(url1);
  const json1 = await res1.json();
  console.log(`exact: url: ${url1}`);
  console.log(`exact: Found ${(json1.data || []).length} prints`);
  
  // Try 2: Exclamation search operator
  const url2 = `https://api.scryfall.com/cards/search?q=!%22${encodeURIComponent(cardName)}%22+is:paper+not:funny&unique=prints`;
  const res2 = await fetch(url2);
  const json2 = await res2.json();
  console.log(`exclamation: url: ${url2}`);
  console.log(`exclamation: Found ${(json2.data || []).length} prints`);
  if (json2.error) {
    console.log(`exclamation error: ${json2.details}`);
  }
}

test();
