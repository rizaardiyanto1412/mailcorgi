import { Users } from 'lucide-react'
import { StubPage } from '../../ui/index.tsx'
import type { Feature } from '../../app/feature.ts'

export const contactsFeature: Feature = {
  name: 'contacts',
  nav: [{ to: '/contacts', label: 'Contacts', icon: Users }],
  routes: [
    { path: 'contacts', element: <StubPage title="Contacts" body="Add a contact, import a CSV or share your signup form." icon={<Users />} /> },
    { path: 'contacts/:id', element: <StubPage title="Contact" body="One subscriber, their fields, tags and timeline." icon={<Users />} /> },
  ],
}
