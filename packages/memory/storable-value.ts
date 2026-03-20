import {
  canBeStored,
  cloneIfNecessary,
  fabricFromNativeValue,
  getDataModelConfig,
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
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
  setDataModelConfig({
    modernDataModel: config.richStorableValues ??
      getDataModelConfig().modernDataModel,
  });
}

export function getExperimentalStorableConfig(): ExperimentalStorableConfig {
  return {
    richStorableValues: getDataModelConfig().modernDataModel,
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
  canBeStored,
  cloneIfNecessary,
  isArrayIndexPropertyName,
  isArrayWithOnlyIndexProperties,
  isFabricValue,
  shallowFabricFromNativeValue as shallowStorableFromNativeValue,
  valueEqual,
};

export type {
  FabricNativeObject as StorableNativeObject,
  FabricValue as StorableValue,
  FabricValueLayer as StorableValueLayer,
};

export function isStorableValue(
  value: unknown,
): value is FabricValueLayer {
  return isFabricValue(value);
}

export function canBeStoredStorable(
  value: unknown,
): value is FabricValue | FabricNativeObject {
  return canBeStored(value);
}
