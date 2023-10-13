/**
 * Copyright (c) HashiCorp, Inc.
 * SPDX-License-Identifier: MPL-2.0
 */

import { Construct } from "constructs";
import { NestedConstructToMoveTo } from "./nested-construct-to-move-to";

export class ConstructToMoveTo extends Construct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new NestedConstructToMoveTo(this, "nested-construct");
  }
}