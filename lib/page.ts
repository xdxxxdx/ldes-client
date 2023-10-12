import { Quad, Term } from "@rdfjs/types";
import { RDF, TREE } from "@treecg/types";
import { CBDShapeExtractor } from "extract-cbd-shape";
import { Store } from "n3";
import * as N3 from "n3";
import { State } from "./state";

export interface Member {
  id: Term;
  quads: Quad[];
}

export interface Relation {
  node: string;
  type: Term;
  value?: Term[];
  path?: Term;
}

export interface Page {
  relations: Relation[];
  node: string;
}

export function extractMembers(
  store: Store,
  stream: Term,
  extractor: CBDShapeExtractor,
  state: State,
  cb: (member: Member) => void,
  shapeId?: Term,
): Promise<void>[] {
  const members = store.getObjects(stream, TREE.terms.member, null);

  const extractMember = async (member: Term) => {
    state.add(member.value);
    const quads = await extractor.extract(
      store,
      <N3.Term>member,
      <N3.Term>shapeId,
    );
    cb({ quads, id: member });
  };

  const out = [];
  for (let member of members) {
    if (!state.seen(member.value)) {
      state.add(member.value);
      out.push(extractMember(member));
    }
  }

  return out;
}

export function extractRelations(store: Store, node: Term): Relation[] {
  const relationIds = store.getObjects(node, TREE.terms.relation, null);

  const out: Relation[] = [];
  for (let relationId of relationIds) {
    const node = store.getObjects(relationId, TREE.terms.node, null)[0];
    const ty = store.getObjects(relationId, RDF.terms.type, null)[0];
    out.push({
      node: node.value,
      type: ty,
    });
  }

  return out;
}