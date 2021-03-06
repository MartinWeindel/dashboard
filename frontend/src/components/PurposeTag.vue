<!--
Copyright (c) 2020 by SAP SE or an SAP affiliate company. All rights reserved. This file is licensed under the Apache Software License, v. 2 except as noted otherwise in the LICENSE file

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

     http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

<template>
  <v-tooltip top>
    <template v-slot:activator="{ on }">
      <v-chip v-on="on" class="purpose-tag" v-if="!!shortPurpose" :outlined="!isCritical" :text-color="textColor" color="cyan darken-2" small>{{ shortPurpose }}</v-chip>
    </template>
    <span>{{ purpose }}</span>
  </v-tooltip>
</template>

<script>
import toUpper from 'lodash/toUpper'

export default {
  props: {
    purpose: {
      type: String
    }
  },
  computed: {
    shortPurpose () {
      switch (this.purpose) {
        case 'evaluation':
          return 'EVAL'
        case 'development':
          return 'DEV'
        case 'production':
          return 'PROD'
        case 'infrastructure':
          return 'INFRA'
        case 'testing':
          return 'TEST'
        default:
          return toUpper(this.purpose)
      }
    },
    isCritical () {
      return this.purpose === 'production' || this.purpose === 'infrastructure'
    },
    textColor () {
      if (!this.isCritical) {
        return 'cyan darken-2'
      } else {
        return 'white'
      }
    }
  }
}
</script>

<style lang="scss" scoped>

  .purpose-tag {
    margin: 1px;
  }

  .purpose-tag ::v-deep .v-chip__content {
    margin: -4px;
  }

</style>
