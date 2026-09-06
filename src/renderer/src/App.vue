<script setup>
import { ElConfigProvider } from 'element-plus'
import { useElementLocale } from './i18n/element-locale'
import AppUpdateDialog from './components/AppUpdateDialog.vue'
import BookWorkspace from './components/BookWorkspace.vue'
import { useAppUpdaterWindowEvents } from './composables/useAppUpdaterWindowEvents'

const { elementLocale } = useElementLocale()
useAppUpdaterWindowEvents()
</script>

<template>
  <el-config-provider :locale="elementLocale">
    <AppUpdateDialog />
    <router-view v-slot="{ Component, route }">
      <BookWorkspace v-if="route.meta.bookWorkspace" :component="Component" />
      <component :is="Component" v-else :key="route.fullPath" />
    </router-view>
  </el-config-provider>
</template>
