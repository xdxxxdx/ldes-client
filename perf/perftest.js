const Benchmark = require("benchmark");
const suite = new Benchmark.Suite();
const { replicateLDES } = require("../dist/lib/client");
const { intoConfig } = require("../dist/lib/config");
const { Parser } = require("n3");
const { rmSync, read } = require("fs");


suite
    .add("descending tree, emits ordered", async function() {
        let client = await replicateLDES(
            intoConfig({
              url: base,
              fetcher: { maxFetched: 2, concurrentRequests: 10 },
              mediator: { maxRequests: 1, maxMembers: 1, },
            }),
            undefined,
            undefined,
            "descending",
          );
       
         console.log(read(client.stream()));
      })
    //   .add("ascending tree, emits ordered", async function() {
    //     let client = await replicateLDES(
    //         intoConfig({
    //           url: "https://www.pieter.pm/dcat/sweden/feed.ttl",
    //           fetcher: { maxFetched: 2, concurrentRequests: 10 },
    //           mediator: { maxRequests: 1, maxMembers: 1, },
    //         }),
    //         undefined,
    //         undefined,
    //         "descending",
    //       );   
    //       client.close();   
    //     // console.log(client);
    //   })
    
    // Add more benchmarks if needed

// Add listeners
.on('cycle', function(event) {
  console.log(String(event.target));
})
.on('complete', function() {
  console.log('Benchmark of ldes-client is completed.');
})
// Run the benchmarks
.run({ 'async': true });