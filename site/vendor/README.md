# Plotly deployment asset

`plotly.min.js` is the Plotly.js 6.9.0 bundle shipped by the `plotly` package
in the `cm2-neuronalsignal` conda environment. The local Flask server reads that
installed bundle at runtime; the Sites deployment vendors the exact same bytes
so the deployed Worker does not depend on Python.

The expected byte length and SHA-256 digest are pinned in
`../cache-deployment.json` and checked before every deployment build.

Plotly.js is distributed under the MIT license.
