/**
 * Test fixtures for hashing.
 */

interface NumbersHashTuple {
  numbers: readonly number[];
  sha256: string;
}

export interface ContentHashTuple extends NumbersHashTuple {
  bytes: Uint8Array;
}

const BIG_TEXT_FILE = Deno.readTextFileSync(
  new URL("fixture-frank.txt", import.meta.url),
);

const NUMBERS_FIXTURES: readonly NumbersHashTuple[] = [
  {
    numbers: [],
    sha256: "47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
  },
  {
    numbers: new Array(1).fill(0),
    sha256: "bjQLnP-zepicpUTmu3gKLHiQHT-zNzh2hRGjBhevoB0",
  },
  {
    numbers: new Array(2).fill(0),
    sha256: "lqKW0iTyhcZ77pPDD4owkVfw2qNdxbh-QQt4YwoJz8c",
  },
  {
    numbers: new Array(3).fill(0),
    sha256: "cJ6AyISHokEeHuTfufIqhhSS0gxHZRUMDHlKvXD4FHw",
  },
  {
    numbers: new Array(4).fill(0),
    sha256: "3z9hmASpL9tAVxktxD3XSOp3itxSvEmM6AUkwBS4ERk",
  },
  {
    numbers: new Array(5).fill(0),
    sha256: "iFVQiq3hbsVz0h5qSF39CnYkCFwaFLXs3WSF3gxoOaQ",
  },
  {
    numbers: new Array(100).fill(0),
    sha256: "zQDiksWXDTxeLw_6UXHlVbxGv8T63ftKQYtoQLhueaM",
  },
  {
    numbers: new Array(1000).fill(0),
    sha256: "VBs-naoJsgv4X6Jz5cvT6AGFqk7CmOdl24d0K3ATilM",
  },
  {
    numbers: new Array(10000).fill(0),
    sha256: "lbUyzEOBr_3_DZVuElIKBBKe1J034VQig2j-ViHwuaI",
  },
  {
    numbers: new Array(100000).fill(0),
    sha256: "kZLCW3NPy62-MtrcKAicYNsOOfkMwgzi5XM_VyYazAw",
  },
  {
    numbers: new Array(1).fill(200),
    sha256: "fFvS0UT93kmEBu3Ln-YM5lsN-l8t16dhf1BePUbWi9s",
  },
  {
    numbers: new Array(2).fill(210),
    sha256: "9fUHJuJIDMoPngMaesN1E5wwECzvLQfY77ol1U7c-Rg",
  },
  {
    numbers: new Array(3).fill(220),
    sha256: "czkz__2Q2ArL8-AblAUh_TlmMaUw0UvKpMJPUnaD_I0",
  },
  {
    numbers: new Array(4).fill(240),
    sha256: "cjXm14AjgRFUyLr8n_m_ppTAhRaLoMU8UGEvHJsXsRs",
  },
  {
    numbers: new Array(5).fill(255),
    sha256: "EyNpo7fyT6YZeFxOLu5ohV9dRsvgqqGerdDbwt1ZLDk",
  },
  {
    numbers: new Array(100).fill(120),
    sha256: "Cey268i878cz9vLsRPeRq-7WqZ7fDMMVGWN4mK69Utg",
  },
  {
    numbers: new Array(1000).fill(121),
    sha256: "fjOuPx6I3fMpEQnMNmsS3Ni_j-d77FMAnyAKduRknAc",
  },
  {
    numbers: new Array(10000).fill(122),
    sha256: "C3Iripa_6Eo70W2dQc0qGkM15rl01uoEEr3v9EYuR58",
  },
  {
    numbers: new Array(100000).fill(123),
    sha256: "n6_r803mJ88PloqDmCorxjQ0a2eTfD9TWfMxp0wvS8g",
  },
  {
    numbers: [...BIG_TEXT_FILE].map((c) => c.charCodeAt(0)),
    sha256: "YXDqseQm9n0pXjTFlvopfttK2yLpUQQDs1llL7rst1A",
  },
] as const;

export const FIXTURES: readonly ContentHashTuple[] = Object.freeze(
  NUMBERS_FIXTURES.map(
    (one: NumbersHashTuple): ContentHashTuple => {
      return {
        bytes: new Uint8Array(one.numbers),
        ...one,
      };
    },
  ),
);
