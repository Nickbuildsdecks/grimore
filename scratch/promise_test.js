let queue = Promise.resolve();

function add(name, shouldFail) {
  return new Promise((resolve, reject) => {
    queue = queue
      .catch(() => {}) // Clean the state from previous errors!
      .then(() => new Promise(r => setTimeout(r, 10)))
      .then(() => {
        if (shouldFail) {
          throw new Error(name + " failed");
        }
        return name + " success";
      });
      
    queue.then(resolve, reject);
  });
}

async function test() {
  try {
    console.log(await add("req1", false));
  } catch(e) { console.log(e.message); }
  
  try {
    console.log(await add("req2", true));
  } catch(e) { console.log(e.message); }
  
  try {
    console.log(await add("req3", false));
  } catch(e) { console.log(e.message); }
}

test();
