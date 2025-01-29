export const JsonTable: React.FC<{ json: string }> = ({ json }) => {
  const parseJson = (jsonString: string) => {
    try {
      return JSON.parse(jsonString);
    } catch {
      return null;
    }
  };

  const isDataUrl = (str: string): boolean => {
    return str.startsWith("data:");
  };

  const isUrl = (str: string): boolean => {
    try {
      new URL(str);
      return true;
    } catch {
      return false;
    }
  };

  const renderValue = (value: any): JSX.Element => {
    if (value === null) return <span className="text-gray-400">null</span>;
    if (typeof value === "boolean")
      return <span className="text-purple-600">{value.toString()}</span>;
    if (typeof value === "number")
      return <span className="text-blue-600">{value}</span>;
    if (typeof value === "string") {
      if (isDataUrl(value)) {
        return (
          <img
            src={value}
            alt="Data URL"
            className="max-w-xs max-h-xs object-contain"
          />
        );
      }
      if (isUrl(value)) {
        return (
          <a
            href={value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 hover:underline"
          >
            {value}
          </a>
        );
      }
      return <span className="text-green-600">"{value}"</span>;
    }
    if (Array.isArray(value)) return <JsonArrayView data={value} />;
    if (typeof value === "object") return <JsonObjectView data={value} />;
    return <span>{String(value)}</span>;
  };

  const JsonObjectView: React.FC<{ data: Record<string, any> }> = ({
    data,
  }) => {
    return (
      <div className="">
        <div className="grid gap-2">
          {Object.entries(data).map(([key, value], i) => (
            <div
              key={key}
              className={`${i % 2 === 0 ? "bg-gray-50" : "bg-white"} p-2 rounded`}
            >
              <div className="text-xs text-gray-500 mb-1">{key}</div>
              <div className="text-sm">{renderValue(value)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const JsonArrayView: React.FC<{ data: any[] }> = ({ data }) => {
    return (
      <div>
        <div className="grid gap-2 p-2">
          {data.map((item, index) => (
            <div key={index} className="bg-gray-50 p-2 rounded">
              <div className="text-xs text-gray-500 mb-1">[{index}]</div>
              <div className="text-sm">{renderValue(item)}</div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  const parsedData = parseJson(json);

  if (parsedData === null) {
    return (
      <div className="text-red-500 p-2 bg-red-50 rounded text-sm">
        Invalid JSON string
      </div>
    );
  }

  return (
    <div className="bg-white rounded border border-gray-200">
      <div className="">{renderValue(parsedData)}</div>
    </div>
  );
};
