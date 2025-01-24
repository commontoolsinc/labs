import { useState, useEffect } from 'react';
import { getAllBlobs } from './api';

type Blob = [string, any]

export const BlobTable: React.FC = () => {
  const [blobs, setBlobs] = useState<Blob[]>([]);

  useEffect(() => {
    const fetchBlobs = async () => {
      const allBlobs = await getAllBlobs();
      console.log(Object.entries(allBlobs))
      setBlobs(Object.entries(allBlobs));
    };
    fetchBlobs();
  }, []);

  return (
    <table>
      <thead>
        <tr>
          <th>ID</th>
          <th>Data</th>
        </tr>
      </thead>
      <tbody>
        {blobs.map(([key, blob]) => (
          <tr key={key}>
            <td>{key}</td>
            <td><pre>{JSON.stringify(blob, null, 2)}</pre></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};
