import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { colors, radius, spacing } from '../theme';

const CHANNEL_STYLE = {
  production: { bg: colors.successSoft, fg: colors.success },
  beta: { bg: colors.betaSoft, fg: colors.beta },
  canary: { bg: colors.canarySoft, fg: colors.canary },
};

export default function Header({ version, channel, rollout, runState }) {
  const badge = CHANNEL_STYLE[channel] || { bg: colors.primarySoft, fg: colors.primary };
  return (
    <View style={styles.wrap}>
      <View style={styles.top}>
        <Text style={styles.app}>HotUpdate Demo</Text>
        <View style={[styles.badge, { backgroundColor: badge.bg }]}>
          <Text style={[styles.badgeText, { color: badge.fg }]}>
            {channel || '未配置'}
            {typeof rollout === 'number' ? ` · ${rollout}%` : ''}
          </Text>
        </View>
      </View>
      <Text style={styles.title}>{version}</Text>
      <Text style={styles.sub}>{runState}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginBottom: spacing.gap,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  app: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.muted,
    letterSpacing: 0.3,
  },
  badge: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
  },
  badgeText: {
    fontSize: 12,
    fontWeight: '600',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.text,
  },
  sub: {
    marginTop: 6,
    fontSize: 13,
    color: colors.muted,
  },
});
