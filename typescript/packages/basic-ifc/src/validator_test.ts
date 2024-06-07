// IFC examples, expressed as tests

import {
  assertEquals,
  assert,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { TrustStatements, makeLattice } from "./lattice.ts";
import { Recipe } from "./recipe.ts";
import {
  Concept,
  Environment,
  ModuleOutput,
  ModulePrincipal,
  NetworkCapability,
  URLPattern,
} from "./principals.ts";
import { ModuleDefinition } from "./module.ts";
import { Guardrail } from "./guardrail.ts";
import { validate } from "./validator.ts";

const CONCEPT_BASE = "https://commonfabric.org/guardrails/concepts/";
function concept(name: string) {
  return new Concept(CONCEPT_BASE + name);
}

Deno.test("Simple recipe", () => {
  const trust = new TrustStatements();

  // Define trusted environments
  const onDevice = concept("on-device");
  const confidentialCloud = concept("confidential-cloud");
  const enterpriseLevelAPIs = concept("trusted-apis");

  trust.add(enterpriseLevelAPIs, [confidentialCloud]);
  trust.add(confidentialCloud, [onDevice]);

  // Add confidential cloud providers
  const azureCC = concept("azure-cc");
  const gcpCC = concept("gcp-cc");

  trust.add(confidentialCloud, [azureCC, gcpCC]);
  trust.add(azureCC, [new Environment("keys from Azure, etc.")]);
  trust.add(gcpCC, [new Environment("keys from GCP, etc.")]);

  // Add trusted API providers
  const openAI = concept("openai");
  const anthropic = concept("anthropic");
  trust.add(enterpriseLevelAPIs, [openAI, anthropic]);
  trust.add(openAI, [
    new NetworkCapability(new URLPattern("https://openai.azure.com")),
  ]);
  trust.add(anthropic, [
    new NetworkCapability(new URLPattern("https://api.anthropic.com")),
  ]);

  // Declare some data
  const birthdate = concept("birthdate");
  const astrologicalSign = concept("astrological-sign");

  // Guardrails for different levels of sensitivity
  const guardrailLessSensitive = new Guardrail([enterpriseLevelAPIs], []);
  const guardrailSensitive = new Guardrail(
    [confidentialCloud],
    [[[astrologicalSign], guardrailLessSensitive]]
  );

  // Add a trusted module
  const computeAstrolicalSign = concept("compute-astrological-sign");
  trust.add(astrologicalSign, [
    new ModuleOutput(computeAstrolicalSign, { birthdate: birthdate }),
  ]);
  trust.add(computeAstrolicalSign, new ModulePrincipal("0xcoffee"));

  const lattice = makeLattice(trust);

  const recipe: Recipe = {
    nodes: [
      {
        id: "#astrological-sign",
        module: "compute-astrological-sign",
        in: [[["birthdate"], ["#governmentId", "birthdate"]]],
      },
    ],
  };

  const modules = new Map([
    ["compute-astrological-sign", { hash: "0xcoffee" } as ModuleDefinition],
  ]);

  const result = validate(recipe, lattice, modules, [
    {
      path: ["#governmentId", "birthdate"],
      minimumConfidentiality: guardrailSensitive,
    },
  ]);

  assertEquals(result, []);
});
