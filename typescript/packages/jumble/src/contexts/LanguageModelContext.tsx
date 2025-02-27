import React, { createContext, useCallback, useContext, useState } from "react";

interface LanguageModelContextType {
  modelId: string | null;
  setPreferredModel: (modelId: string) => void;
}

const LanguageModelContext = createContext<LanguageModelContextType>({
  modelId: "groq:llama-3.3-70b-versatile",
  setPreferredModel: () => { },
});

export const LanguageModelProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [modelId, setModelId] = useState<string | null>("groq:llama-3.3-70b-versatile");

  const setPreferredModel = useCallback((modelId: string) => {
    setModelId(modelId);
  }, []);

  return (
    <LanguageModelContext.Provider value={{ modelId, setPreferredModel }}>
      {children}
    </LanguageModelContext.Provider>
  );
};

export const usePreferredLanguageModel = () => useContext(LanguageModelContext);
