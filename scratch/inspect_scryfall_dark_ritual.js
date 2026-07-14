async function test() {
  const cardName = "Dark Ritual";
  const url = `https://api.scryfall.com/cards/search?q=exact:%22${encodeURIComponent(cardName)}%22+is:paper+not:funny&unique=prints`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Grimore/1.0 (grimore@lgs.com)'
    }
  });
  const json = await res.json();
  console.log(`Found ${(json.data || []).length} prints`);
  if (json.data && json.data.length > 0) {
    const len = json.data.length;
    console.log("FIRST 3 prints:");
    for (let i = 0; i < Math.min(3, len); i++) {
      const p = json.data[i];
      console.log(`- Set: ${p.set_name} (${p.set.toUpperCase()}), Name: ${p.name}, Price: ${JSON.stringify(p.prices)}`);
    }
    console.log("LAST 3 prints:");
    for (let i = Math.max(0, len - 3); i < len; i++) {
      const p = json.data[i];
      console.log(`- Set: ${p.set_name} (${p.set.toUpperCase()}), Name: ${p.name}, Price: ${JSON.stringify(p.prices)}`);
    }
  }
}

test();
