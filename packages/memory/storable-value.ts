import {
  cloneIfNecessary,
  fabricFromNativeValue,
  getDataModelConfig,
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
  isFabricCompatible,
  isFabricValue,
  nativeFromFabricValue,
  resetDataModelConfig,
  setDataModelConfig,
  shallowFabricFromNativeValue,
  valueEqual,
} from "@commontools/data-model/fabric-value";
import type {
  CloneOptions,
  FabricNativeObject,
  FabricValue,
  FabricValueLayer,
} from "@commontools/data-model/fabric-value";

export type { CloneOptions };

export interface ExperimentalStorableConfig {
  richStorableValues: boolean;
}

export function setStorableValueConfig(
  config: Partial<ExperimentalStorableConfig>,
): void {
  setDataModelConfig(config.richStorableValues ?? getDataModelConfig());
}

export function getExperimentalStorableConfig(): ExperimentalStorableConfig {
  return {
    richStorableValues: getDataModelConfig(),
  };
}

export function resetStorableValueConfig(): void {
  resetDataModelConfig();
}

export function storableFromNativeValue(
  value: unknown,
  freeze = true,
): FabricValue {
  return fabricFromNativeValue(value, freeze);
}

export function nativeFromStorableValue(
  value: FabricValue,
  frozen = true,
): FabricValue {
  return nativeFromFabricValue(value, frozen);
}

export {
  cloneIfNecessary,
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
  isFabricValue,
  shallowFabricFromNativeValue as shallowStorableFromNativeValue,
  valueEqual,
};

export type { FabricNativeObject, FabricValue, FabricValueLayer };

export const canBeStored = isFabricCompatible;

export function isStorableValue(
  value: unknown,
): value is FabricValueLayer {
  return isFabricValue(value);
}

export function canBeStoredStorable(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return isFabricCompatible(value);
}
