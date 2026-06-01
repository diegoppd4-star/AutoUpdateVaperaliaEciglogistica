# docs

Documentacion que acompana al orquestador.

## `SCRAPPER_ARCHITECTURE.md`

Contrato tecnico del scraper Eciglogistica/Vaperalia.

Se incluye porque el auto-update depende de que el scrapeo produzca los campos correctos. El runner puede validar el JSON, pero no puede inventar campos ausentes.

## `AGENT_HANDOFF_PIPELINE_COMPLETO.md`

Documento de transferencia de conocimiento para otro agente o desarrollador.

Resume la logica completa del pipeline, los problemas historicos, las reglas de matching y la separacion entre determinismo, IA no determinista y BDD.

## `SCRAPER_INTEGRATION.md`

Describe como se ejecuta el scraper incluido antes del pipeline, donde deja `output.json` y que parametros del runner controlan ese paso.

Runner principal: `../run_auto_update.mjs`.
