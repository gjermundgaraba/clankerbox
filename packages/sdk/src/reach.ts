export const tailnetOrLoopbackRule =
  "a tailnet address (100.64.0.0/10, fd7a:115c:a1e0::/48) or a loopback address";

const octet = /^(?:0|[1-9]\d{0,2})$/u;

const hextet = /^[0-9a-f]{1,4}$/iu;

const ipv4 = (text: string): readonly number[] | undefined => {
  const parts = text.split(".");

  if (parts.length !== 4 || !parts.every((part) => octet.test(part))) {
    return undefined;
  }

  const bytes = parts.map(Number);

  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
};

const groupsOf = (text: string): readonly string[] =>
  text === "" ? [] : text.split(":");

const ipv6 = (text: string): readonly number[] | undefined => {
  let body = text;
  let tail: readonly number[] = [];

  if (text.includes(".")) {
    const cut = text.lastIndexOf(":");
    const four = ipv4(text.slice(cut + 1));

    if (four === undefined) {
      return undefined;
    }

    const [a = 0, b = 0, c = 0, d = 0] = four;

    tail = [(a << 8) | b, (c << 8) | d];
    body = text.slice(0, cut + 1);
    body = body.endsWith("::") ? body : body.slice(0, -1);
  }

  const halves = body.split("::");

  if (halves.length > 2) {
    return undefined;
  }

  const [first = "", second] = halves;
  const head = groupsOf(first);
  const rest = second === undefined ? [] : groupsOf(second);

  if (![...head, ...rest].every((group) => hextet.test(group))) {
    return undefined;
  }

  const given = head.length + rest.length + tail.length;

  if (halves.length === 1 ? given !== 8 : given > 7) {
    return undefined;
  }

  return [
    ...[...head, ...Array.from({ length: 8 - given }, () => "0"), ...rest].map(
      (group) => Number.parseInt(group, 16)
    ),
    ...tail,
  ];
};

const v4Reaches = ([a, b = 0]: readonly number[]): boolean =>
  a === 127 || (a === 100 && (b & 0xc0) === 64);

export const isTailnetOrLoopback = (address: string): boolean => {
  const four = ipv4(address);

  if (four !== undefined) {
    return v4Reaches(four);
  }

  const groups = ipv6(address);

  if (groups === undefined) {
    return false;
  }

  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7] = groups;
  const leadingZeros = [g0, g1, g2, g3, g4].every((g) => g === 0);

  return (
    (leadingZeros && g5 === 0 && g6 === 0 && g7 === 1) ||
    (g0 === 0xfd_7a && g1 === 0x11_5c && g2 === 0xa1_e0) ||
    (leadingZeros && g5 === 0xff_ff && v4Reaches([g6 >> 8, g6 & 0xff]))
  );
};
