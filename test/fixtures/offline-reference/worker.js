// Synthetic deterministic compute, not speech synthesis. It exercises worker
// loading and checkpoint recovery without downloading a third-party model.
self.addEventListener('message', ({ data }) => {
  let result = data.sum;
  for (const character of data.text) result = (result + character.codePointAt(0) * (data.step + 1)) % 1000000007;
  self.postMessage({ step: data.step + 1, sum: result });
});
