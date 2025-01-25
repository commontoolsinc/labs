import { useAllBlobs } from "./api.ts";

type Blob = [string, any];

const tableStyles = {
  container:
    "min-w-full divide-y divide-gray-200 shadow-sm rounded-lg overflow-hidden",
  header: "bg-gray-50",
  headerCell:
    "px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider",
  row: "bg-white hover:bg-gray-50",
  cell: "px-6 py-4 whitespace-nowrap text-sm text-gray-900",
  idCell: "font-medium",
  jsonCell: "font-mono text-xs overflow-x-auto",
  pre: "bg-gray-50 p-3 rounded",
};

export const BlobTable: React.FC = () => {
  const { blobs } = useAllBlobs();

  return (
    <div className="overflow-x-auto">
      <table className={tableStyles.container}>
        <thead className={tableStyles.header}>
          <tr>
            <th className={tableStyles.headerCell}>ID</th>
            <th className={tableStyles.headerCell}>Data</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200">
          {blobs.map(([key, blob]) => (
            <tr key={key} className={tableStyles.row}>
              <td className={`${tableStyles.cell} ${tableStyles.idCell}`}>
                {key}
              </td>
              <td className={`${tableStyles.cell} ${tableStyles.jsonCell}`}>
                <pre className={tableStyles.pre}>
                  {JSON.stringify(blob, null, 2)}
                </pre>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
